import type { Message, WebSocketFrame, WebStatePatch, WebStateSnapshot } from "@wren/protocol"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { getToken } from "./api"

export type ConnectionStatus = "connecting" | "connected" | "disconnected"

export const EMPTY_SNAPSHOT: WebStateSnapshot = {
  sessions: [],
  titles: {},
  previews: {},
  messages: {},
  permissions: {},
  questions: {},
  todos: {},
  status: {},
  diffs: {},
  compactProgress: {},
}

export type WebStore = {
  readonly state: WebStateSnapshot
  readonly connection: () => ConnectionStatus
  replace(snapshot: WebStateSnapshot): void
  apply(patch: WebStatePatch): void
  connect(): void
}

/**
 * Pure reducer: applies a patch to an immutable snapshot. Used by tests and
 * as the reference semantics for the Solid store updates.
 */
export function applyPatch(state: WebStateSnapshot, patch: WebStatePatch): WebStateSnapshot {
  return {
    sessions: patch.sessions ?? state.sessions,
    titles: patch.titles ?? state.titles,
    previews: patch.previews ?? state.previews,
    todos: patch.todos ?? state.todos,
    status: patch.status ?? state.status,
    diffs: patch.diffs ?? state.diffs,
    compactProgress: patch.compactProgress ?? state.compactProgress,
    permissions: patch.permissions ?? state.permissions,
    questions: patch.questions ?? state.questions,
    messages: applyMessagePatches(state.messages, patch.messages),
  }
}

function applyMessagePatches(
  messages: Record<string, Message[]>,
  patches: WebStatePatch["messages"],
): Record<string, Message[]> {
  if (patches === undefined || patches.length === 0) return messages
  const next = { ...messages }
  for (const patch of patches) {
    if (patch.mode === "replaceAll") {
      next[patch.sessionId] = patch.messages
      continue
    }
    const existing = next[patch.sessionId] ?? []
    const byId = new Map(patch.messages.map((message) => [message.id, message]))
    const replaced = existing.map((message) => byId.get(message.id) ?? message)
    const appended = patch.messages.filter((message) => !existing.some((e) => e.id === message.id))
    next[patch.sessionId] = [...replaced, ...appended]
  }
  return next
}

export function createWebStore(): WebStore {
  const [state, setState] = createStore<WebStateSnapshot>(EMPTY_SNAPSHOT)
  const [connection, setConnection] = createSignal<ConnectionStatus>("disconnected")

  // sessionId → messageId → array index. Keeps streamed token updates to a
  // single path setter instead of rebuilding the whole messages array.
  const indexes = new Map<string, Map<string, number>>()

  function rebuildIndex(sessionId: string, messages: readonly Message[]): void {
    const map = new Map<string, number>()
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message !== undefined) map.set(message.id, i)
    }
    indexes.set(sessionId, map)
  }

  function replace(snapshot: WebStateSnapshot): void {
    setState(snapshot)
    indexes.clear()
    for (const [sessionId, messages] of Object.entries(snapshot.messages)) {
      rebuildIndex(sessionId, messages)
    }
  }

  function applyUpsert(sessionId: string, messages: readonly Message[]): void {
    let index = indexes.get(sessionId)
    const existing = state.messages[sessionId] ?? []
    if (index === undefined) {
      const built = new Map<string, number>()
      for (let i = 0; i < existing.length; i++) {
        const message = existing[i]
        if (message !== undefined) built.set(message.id, i)
      }
      index = built
      indexes.set(sessionId, index)
    }
    let appendedCount = 0
    for (const message of messages) {
      const i = index.get(message.id)
      if (i !== undefined && i < existing.length && existing[i]?.id === message.id) {
        setState("messages", sessionId, i, message)
      } else {
        // Unknown id (new message) or stale index — map-based upsert is
        // correct in both cases.
        setState("messages", sessionId, (prev: Message[]) =>
          prev.some((m) => m.id === message.id)
            ? prev.map((m) => (m.id === message.id ? message : m))
            : [...prev, message],
        )
        if (i === undefined) appendedCount += 1
      }
    }
    if (appendedCount > 0) {
      rebuildIndex(sessionId, [...existing, ...messages])
    }
  }

  function apply(patch: WebStatePatch): void {
    if (patch.sessions !== undefined) setState("sessions", patch.sessions)
    if (patch.titles !== undefined) setState("titles", patch.titles)
    if (patch.previews !== undefined) setState("previews", patch.previews)
    if (patch.todos !== undefined) setState("todos", patch.todos)
    if (patch.status !== undefined) setState("status", patch.status)
    if (patch.diffs !== undefined) setState("diffs", patch.diffs)
    if (patch.compactProgress !== undefined) setState("compactProgress", patch.compactProgress)
    if (patch.permissions !== undefined) setState("permissions", patch.permissions)
    if (patch.questions !== undefined) setState("questions", patch.questions)
    if (patch.messages !== undefined) {
      for (const messagePatch of patch.messages) {
        if (messagePatch.mode === "replaceAll") {
          setState("messages", messagePatch.sessionId, messagePatch.messages)
          rebuildIndex(messagePatch.sessionId, messagePatch.messages)
        } else {
          applyUpsert(messagePatch.sessionId, messagePatch.messages)
        }
      }
    }
  }

  function connect(): void {
    const closed = false
    let attempt = 0

    const scheduleReconnect = (): void => {
      if (closed) return
      const delay = Math.min(500 * 2 ** attempt, 10_000)
      attempt += 1
      setTimeout(connect, delay)
    }

    const connect = (): void => {
      if (closed) return
      setConnection("connecting")
      const token = getToken()
      let socket: WebSocket
      try {
        socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`)
      } catch {
        scheduleReconnect()
        return
      }
      socket.onopen = () => {
        attempt = 0
        setConnection("connected")
      }
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as WebSocketFrame
          if (frame.type === "snapshot") replace(frame.state)
          else apply(frame.patch)
        } catch {
          // ignore malformed frames
        }
      }
      socket.onclose = () => {
        setConnection("disconnected")
        scheduleReconnect()
      }
      socket.onerror = () => {
        socket.close()
      }
    }

    connect()
  }

  return { state, connection, replace, apply, connect }
}

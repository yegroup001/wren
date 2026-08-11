import {
  type Diff,
  type Message,
  type Part,
  type PartId,
  type PermissionRequest,
  parseMessageId,
  parsePartId,
  parseSessionId,
  type QuestionRequest,
  type Session,
  type SessionId,
  type SessionPreview,
  type SnapshotFileDiff,
  type Status,
  type Todo,
} from "@wren/protocol"
import { batch } from "solid-js"
import { createStore as createSolidStore, produce, unwrap } from "solid-js/store"

export type CompactProgressSegment = {
  readonly type: "text" | "thinking"
  readonly text: string
}

export type CompactProgress = {
  readonly phase: "preparing" | "summarizing" | "finalizing"
  readonly segments: readonly CompactProgressSegment[]
}

export type TuiStore = {
  sessions: Session[]
  previews: Record<string, SessionPreview>
  messages: Record<string, Message[]>
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  todos: Record<string, Todo[]>
  status: Record<string, Status>
  diffs: Record<string, Diff>
  compactProgress: Record<string, CompactProgress | undefined>
}

export type ConversationProjectionSnapshot = {
  readonly messages: readonly Message[]
  readonly todos: readonly Todo[]
  readonly status: Status
  readonly diff: Diff
  readonly permissionMode: string
  readonly permissions: readonly PermissionRequest[]
  readonly questions: readonly QuestionRequest[]
}

export type TuiStoreApi = {
  readonly store: TuiStore
  readonly addSession: (session: Session) => void
  readonly setPreview: (sessionId: SessionId, preview: SessionPreview) => void
  readonly getSession: (sessionId: SessionId) => Session | undefined
  readonly setSessionModel: (
    sessionId: SessionId,
    modelId: string,
    modelRef?: Session["modelRef"],
  ) => void
  readonly setSessionPermissionMode: (sessionId: SessionId, permissionMode: string) => void
  readonly setSessionEffort: (sessionId: SessionId, effort: NonNullable<Session["effort"]>) => void
  readonly deleteSession: (sessionId: SessionId) => void
  readonly hydrateSessionMessages: (sessionId: SessionId, messages: readonly Message[]) => void
  readonly addMessage: (message: Message) => void
  readonly addMessageBeforeQueued: (message: Message) => void
  readonly removeMessage: (sessionId: SessionId, messageId: Message["id"]) => void
  readonly removeMessagesFrom: (sessionId: SessionId, messageId: Message["id"]) => void
  readonly replaceMessage: (
    sessionId: SessionId,
    oldMessageId: Message["id"],
    newMessage: Message,
  ) => void
  readonly addPart: (sessionId: SessionId, messageId: Message["id"], part: Part) => void
  readonly updatePart: (
    sessionId: SessionId,
    messageId: Message["id"],
    partId: PartId,
    update: (part: Part) => Part,
  ) => void
  readonly appendPartText: (
    sessionId: SessionId,
    messageId: Message["id"],
    partId: PartId,
    text: string,
  ) => void
  readonly setPermission: (request: PermissionRequest) => void
  readonly resolvePermission: (sessionId: SessionId, requestId: string) => void
  readonly setQuestion: (request: QuestionRequest) => void
  readonly resolveQuestion: (sessionId: SessionId, requestId: string) => void
  readonly setTodos: (sessionId: SessionId, todos: Todo[]) => void
  readonly setStatus: (sessionId: SessionId, status: Status) => void
  readonly setDiff: (diff: Diff) => void
  readonly setCompactProgress: (sessionId: SessionId, progress: CompactProgress) => void
  readonly appendCompactProgress: (
    sessionId: SessionId,
    type: CompactProgressSegment["type"],
    text: string,
  ) => void
  readonly clearCompactProgress: (sessionId: SessionId) => void
  readonly clearMessageQueued: (sessionId: SessionId, messageId: Message["id"]) => void
  readonly restoreConversation: (
    sessionId: SessionId,
    snapshot: ConversationProjectionSnapshot,
  ) => void
  readonly getBundle: (sessionId: SessionId) =>
    | {
        session: Session
        status: Status
        messages: Message[]
        todos: Todo[]
        permissions: PermissionRequest[]
        questions: QuestionRequest[]
        diff: SnapshotFileDiff[]
      }
    | undefined
}

function emptyStore(): TuiStore {
  return {
    sessions: [],
    previews: {},
    messages: {},
    permissions: {},
    questions: {},
    todos: {},
    status: {},
    diffs: {},
    compactProgress: {},
  }
}

export function createTuiStore(): TuiStoreApi {
  const [store, setStore] = createSolidStore<TuiStore>(emptyStore())

  // Message id → array index per session. Keeps appendPartText O(1): the
  // produce-based fallback rebuilds the whole messages array per streamed
  // token (O(n) copy) and replaces every message reference, forcing the
  // transcript to re-diff the entire visible window per token.
  const messageIndexes = new Map<SessionId, Map<Message["id"], number>>()

  function rebuildMessageIndexes(
    sessionId: SessionId,
    messages: readonly Message[] | undefined,
  ): void {
    let index = messageIndexes.get(sessionId)
    if (index === undefined) {
      index = new Map()
      messageIndexes.set(sessionId, index)
    } else {
      index.clear()
    }
    if (messages !== undefined) {
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]
        if (message !== undefined) index.set(message.id, i)
      }
    }
  }

  function setMessages(sessionId: SessionId, next: Message[]): void {
    rebuildMessageIndexes(sessionId, next)
    setStore("messages", sessionId, next)
  }

  const addSession = (session: Session): void => {
    batch(() => {
      setStore("sessions", (prev: Session[]) => [...prev, session])
      setStore("status", session.id, { type: "idle" as const })
      setStore("permissions", session.id, [])
      setStore("questions", session.id, [])
      setStore("todos", session.id, [])
      setStore("diffs", session.id, { sessionId: session.id, files: [], updatedAt: "" })
    })
  }

  const setPreview = (sessionId: SessionId, preview: SessionPreview): void => {
    setStore("previews", sessionId, preview)
  }

  const getSession = (sessionId: SessionId): Session | undefined =>
    store.sessions.find((s: Session) => s.id === sessionId)

  const setSessionModel = (
    sessionId: SessionId,
    modelId: string,
    modelRef?: Session["modelRef"],
  ): void => {
    setStore("sessions", (sessions: Session[]) =>
      sessions.map((session: Session) =>
        session.id === sessionId
          ? { ...session, modelId, ...(modelRef !== undefined && { modelRef }) }
          : session,
      ),
    )
  }

  const setSessionPermissionMode = (sessionId: SessionId, permissionMode: string): void => {
    setStore("sessions", (sessions: Session[]) =>
      sessions.map((session: Session) =>
        session.id === sessionId ? { ...session, permissionMode } : session,
      ),
    )
  }

  const setSessionEffort = (sessionId: SessionId, effort: NonNullable<Session["effort"]>): void => {
    setStore("sessions", (sessions: Session[]) =>
      sessions.map((session: Session) =>
        session.id === sessionId
          ? {
              ...session,
              effort,
              ...(session.modelRef !== undefined && {
                modelRef: modelReferenceWithEffort(session.modelRef, effort),
              }),
            }
          : session,
      ),
    )
  }

  const deleteSession = (sessionId: SessionId): void => {
    messageIndexes.delete(sessionId)
    setStore(
      produce((state: TuiStore) => {
        state.sessions = state.sessions.filter((s: Session) => s.id !== sessionId)
        delete state.previews[sessionId]
        delete state.messages[sessionId]
        delete state.permissions[sessionId]
        delete state.questions[sessionId]
        delete state.todos[sessionId]
        delete state.status[sessionId]
        delete state.diffs[sessionId]
        delete state.compactProgress[sessionId]
      }),
    )
  }

  const hydrateSessionMessages = (sessionId: SessionId, messages: readonly Message[]): void => {
    const cloned = messages.map((message) => structuredClone(unwrap(message)))
    batch(() => {
      setMessages(sessionId, cloned)
    })
  }

  const addMessage = (message: Message): void => {
    const safe = store.messages[message.sessionId] ?? []
    const filtered = safe.filter((m: Message) => m.id !== message.id)
    batch(() => {
      setMessages(message.sessionId, [...filtered, message])
    })
  }

  const addMessageBeforeQueued = (message: Message): void => {
    const safe = store.messages[message.sessionId] ?? []
    const filtered = safe.filter((m: Message) => m.id !== message.id)
    const firstQueuedIdx = filtered.findIndex((m: Message) => m.queued === true)
    batch(() => {
      if (firstQueuedIdx === -1) {
        setMessages(message.sessionId, [...filtered, message])
      } else {
        setMessages(message.sessionId, [
          ...filtered.slice(0, firstQueuedIdx),
          message,
          ...filtered.slice(firstQueuedIdx),
        ])
      }
    })
  }

  const removeMessage = (sessionId: SessionId, messageId: Message["id"]): void => {
    const safe = store.messages[sessionId] ?? []
    setMessages(sessionId, safe.filter((m: Message) => m.id !== messageId))
  }

  const removeMessagesFrom = (sessionId: SessionId, messageId: Message["id"]): void => {
    const safe = store.messages[sessionId] ?? []
    const idx = safe.findIndex((m: Message) => m.id === messageId)
    if (idx === -1) return
    setMessages(sessionId, safe.slice(0, idx))
  }

  const replaceMessage = (
    sessionId: SessionId,
    oldMessageId: Message["id"],
    newMessage: Message,
  ): void => {
    const safe = store.messages[sessionId] ?? []
    const idx = safe.findIndex((m: Message) => m.id === oldMessageId)
    if (idx === -1) {
      setMessages(sessionId, [...safe, newMessage])
      return
    }
    const next = [...safe]
    next[idx] = newMessage
    setMessages(sessionId, next)
  }

  const addPart = (sessionId: SessionId, messageId: Message["id"], part: Part): void => {
    const index = messageIndexes.get(sessionId)?.get(messageId)
    if (index === undefined) {
      // Unknown session/message — fall back to the previous behavior so the
      // part is not silently dropped.
      setStore("messages", sessionId, (messages: Message[] | undefined) => {
        const safe = messages ?? []
        return safe.map((m: Message) =>
          m.id === messageId ? { ...m, parts: [...m.parts, part] } : m,
        )
      })
      return
    }
    // Path setter on the parts array: touches only the target message and
    // appends one part, without rebuilding the messages array or replacing
    // sibling message references (the transcript does not re-diff the
    // visible window).
    setStore("messages", sessionId, index, "parts", (parts: Part[]) => [...parts, part])
  }

  const updatePart = (
    sessionId: SessionId,
    messageId: Message["id"],
    partId: PartId,
    update: (part: Part) => Part,
  ): void => {
    const index = messageIndexes.get(sessionId)?.get(messageId)
    if (index === undefined) {
      // Unknown session/message — fall back to the previous behavior so the
      // update is not silently dropped.
      setStore("messages", sessionId, (messages: Message[] | undefined) => {
        const safe = messages ?? []
        return safe.map((m: Message) =>
          m.id === messageId
            ? { ...m, parts: m.parts.map((p: Part) => (p.id === partId ? update(p) : p)) }
            : m,
        )
      })
      return
    }
    const message = store.messages[sessionId]?.[index]
    if (message === undefined) return
    const partIndex = message.parts.findIndex((p: Part) => p.id === partId)
    if (partIndex === -1) return
    // Element setter on the part's index: touches only that part, like
    // appendPartText, instead of rebuilding the whole messages array per
    // tool result / content block update.
    setStore("messages", sessionId, index, "parts", partIndex, (current: Part) => update(current))
  }

  const appendPartText = (
    sessionId: SessionId,
    messageId: Message["id"],
    partId: PartId,
    text: string,
  ): void => {
    const index = messageIndexes.get(sessionId)?.get(messageId)
    if (index === undefined) {
      // Unknown session/message — the produce path also no-ops safely.
      return
    }
    const message = store.messages[sessionId]?.[index]
    if (message === undefined) return
    const partIndex = message.parts.findIndex((p: Part) => p.id === partId)
    if (partIndex === -1) return
    const part = message.parts[partIndex]
    if (part === undefined || (part.type !== "text" && part.type !== "thinking")) return
    // Element setter on the part's index: touches only that part. Unlike
    // produce, it does not rebuild the messages array or replace the
    // sibling message references, so the transcript does not re-diff the
    // visible window per token.
    setStore("messages", sessionId, index, "parts", partIndex, (current: Part) =>
      current.type === "text" || current.type === "thinking"
        ? { ...current, text: current.text + text }
        : current,
    )
  }

  const setPermission = (request: PermissionRequest): void => {
    setStore("permissions", request.sessionId, (prev: PermissionRequest[]) => {
      const filtered = prev.filter((p: PermissionRequest) => p.id !== request.id)
      return [...filtered, request]
    })
  }

  const resolvePermission = (sessionId: SessionId, requestId: string): void => {
    setStore("permissions", sessionId, (prev: PermissionRequest[]) =>
      prev.filter((p: PermissionRequest) => p.id !== requestId),
    )
  }

  const setQuestion = (request: QuestionRequest): void => {
    setStore("questions", request.sessionId, (prev: QuestionRequest[]) => {
      const filtered = prev.filter((q: QuestionRequest) => q.id !== request.id)
      return [...filtered, request]
    })
  }

  const resolveQuestion = (sessionId: SessionId, requestId: string): void => {
    setStore("questions", sessionId, (prev: QuestionRequest[]) =>
      prev.filter((q: QuestionRequest) => q.id !== requestId),
    )
  }

  const setTodos = (sessionId: SessionId, todos: Todo[]): void => {
    setStore("todos", sessionId, [...todos])
  }

  const setStatus = (sessionId: SessionId, status: Status): void => {
    setStore("status", sessionId, status)
  }

  const setDiff = (diff: Diff): void => {
    setStore("diffs", diff.sessionId, diff)
  }

  const setCompactProgress = (sessionId: SessionId, progress: CompactProgress): void => {
    setStore("compactProgress", sessionId, () => ({
      phase: progress.phase,
      segments: progress.segments.map((segment) => ({ ...segment })),
    }))
  }

  const appendCompactProgress = (
    sessionId: SessionId,
    type: CompactProgressSegment["type"],
    text: string,
  ): void => {
    setStore("compactProgress", sessionId, (previous: CompactProgress | undefined) => {
      const progress = previous ?? { phase: "summarizing" as const, segments: [] }
      const last = progress.segments[progress.segments.length - 1]
      const segments =
        last?.type === type
          ? [...progress.segments.slice(0, -1), { ...last, text: last.text + text }]
          : [...progress.segments, { type, text }]
      return { ...progress, segments }
    })
  }

  const clearCompactProgress = (sessionId: SessionId): void => {
    setStore("compactProgress", sessionId, undefined)
  }

  const clearMessageQueued = (sessionId: SessionId, messageId: Message["id"]): void => {
    const index = messageIndexes.get(sessionId)?.get(messageId)
    if (index === undefined) {
      setStore("messages", sessionId, (prev: Message[] | undefined) => {
        const safe = prev ?? []
        return safe.map((m: Message) => (m.id === messageId ? { ...m, queued: undefined } : m))
      })
      return
    }
    setStore("messages", sessionId, index, (m: Message) => ({ ...m, queued: undefined }))
  }

  const restoreConversation = (
    sessionId: SessionId,
    snapshot: ConversationProjectionSnapshot,
  ): void => {
    const restoredMessages = snapshot.messages.map((message) =>
      structuredClone(unwrap(message)),
    )
    batch(() => {
      setMessages(sessionId, restoredMessages)
      setStore("todos", sessionId, () =>
        snapshot.todos.map((todo) => structuredClone(unwrap(todo))),
      )
      setStore("status", sessionId, () => structuredClone(unwrap(snapshot.status)))
      setStore("diffs", sessionId, () => ({
        ...unwrap(snapshot.diff),
        files: snapshot.diff.files.map((file) => structuredClone(unwrap(file))),
      }))
      setStore("sessions", (sessions) =>
        sessions.map((session) =>
          session.id === sessionId
            ? { ...session, permissionMode: snapshot.permissionMode }
            : session,
        ),
      )
      setStore("permissions", sessionId, () =>
        snapshot.permissions.map((p) => structuredClone(unwrap(p))),
      )
      setStore("questions", sessionId, () =>
        snapshot.questions.map((q) => structuredClone(unwrap(q))),
      )
    })
  }

  const getBundle = (sessionId: SessionId) => {
    const session = store.sessions.find((s: Session) => s.id === sessionId)
    if (!session) return undefined
    const status = store.status[sessionId] ?? { type: "idle" as const }
    const messages = store.messages[sessionId] ?? []
    const todos = store.todos[sessionId] ?? []
    const permissions = store.permissions[sessionId] ?? []
    const questions = store.questions[sessionId] ?? []
    const diffEntry = store.diffs[sessionId]
    const diff = diffEntry?.files ?? []
    return { session, status, messages, todos, permissions, questions, diff }
  }

  return {
    store,
    addSession,
    setPreview,
    getSession,
    setSessionModel,
    setSessionPermissionMode,
    setSessionEffort,
    deleteSession,
    hydrateSessionMessages,
    addMessage,
    addMessageBeforeQueued,
    removeMessage,
    removeMessagesFrom,
    replaceMessage,
    addPart,
    updatePart,
    appendPartText,
    setPermission,
    resolvePermission,
    setQuestion,
    resolveQuestion,
    setTodos,
    setStatus,
    setDiff,
    setCompactProgress,
    appendCompactProgress,
    clearCompactProgress,
    clearMessageQueued,
    restoreConversation,
    getBundle,
  }
}

function modelReferenceWithEffort(
  modelRef: NonNullable<Session["modelRef"]>,
  effort: NonNullable<Session["effort"]>,
): NonNullable<Session["modelRef"]> {
  const { effort: _previousEffort, ...reference } = modelRef
  return { ...reference, ...(effort !== "default" && { effort }) }
}

// ---------------------------------------------------------------------------
// ID helpers — create branded IDs from raw strings
// ---------------------------------------------------------------------------

export function makePartId(prefix: string): PartId {
  return parsePartId(prefix)
}

export function makeMessageId(prefix: string): Message["id"] {
  return parseMessageId(prefix)
}

export function makeSessionId(prefix: string): SessionId {
  return parseSessionId(prefix)
}

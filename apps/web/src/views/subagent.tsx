import type { Message, Part } from "@wren/protocol"
import { parseMessageId, parsePartId } from "@wren/protocol"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { api } from "../api"
import { navigate } from "../app"
import type { WebStore } from "../store"
import { deriveSubagentHeader } from "../utils/subagent"
import { Transcript } from "../components/transcript"

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }

interface EngineMessage {
  type: string
  message?: {
    role?: string
    content?: ContentBlock[] | string
    model?: string
    usage?: Record<string, number>
  }
  uuid: string
  timestamp?: string
}

function contentBlockToPart(block: ContentBlock, uuid: string, index: number): Part {
  switch (block.type) {
    case "text":
      return { type: "text", id: parsePartId(`part_sa_${uuid}_${index}`), text: block.text }
    case "thinking":
      return {
        type: "thinking",
        id: parsePartId(`part_sa_${uuid}_${index}`),
        text: block.thinking,
        signature: block.signature,
      }
    case "tool_use":
      return {
        type: "tool_use",
        id: parsePartId(`part_sa_${uuid}_${index}`),
        toolName: block.name,
        input: block.input,
        status: "completed",
      }
    case "tool_result":
      return {
        type: "tool_result",
        id: parsePartId(`part_sa_${uuid}_${index}`),
        toolUseId: block.tool_use_id,
        content: block.content,
      }
  }
}

function extractParts(msg: EngineMessage): Part[] {
  const content = msg.message?.content
  if (typeof content === "string") {
    return [{ type: "text", id: parsePartId(`part_sa_${msg.uuid}_0`), text: content }]
  }
  if (!Array.isArray(content)) return []
  return content.map((block, i) => contentBlockToPart(block, msg.uuid, i))
}

function toMessage(msg: EngineMessage, index: number): Message {
  const role = msg.message?.role ?? "unknown"
  return {
    id: parseMessageId(`msg_sa_${msg.uuid}_${index}`),
    sessionId: "" as never,
    role: role as Message["role"],
    parts: extractParts(msg),
    createdAt: msg.timestamp ?? new Date(0).toISOString(),
  }
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`
  return `${total}`
}

export function SubagentView(props: {
  readonly store: WebStore
  readonly sessionId: string
  readonly agentId: string
}) {
  const [rawMessages, setRawMessages] = createSignal<readonly EngineMessage[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | undefined>(undefined)

  createEffect(() => {
    let cancelled = false
    setRawMessages([])
    setError(undefined)
    setLoading(true)
    void (async () => {
      try {
        const data = await api.getSubagent(props.sessionId, props.agentId)
        if (cancelled) return
        setRawMessages((data.messages ?? []) as EngineMessage[])
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  })

  const messages = createMemo<readonly Message[]>(() =>
    rawMessages()
      .filter(
        (msg) => msg?.message?.role !== undefined || typeof msg?.message?.content === "string",
      )
      .map((msg, i) => toMessage(msg, i))
      .filter((m) => m.parts.length > 0),
  )

  const header = () => deriveSubagentHeader(rawMessages() as unknown[])
  const sessionTitle = () => props.store.state.titles[props.sessionId]

  return (
    <div class="subagent-view">
      <header class="session-header">
        <button
          type="button"
          class="nav-home"
          onClick={() => navigate({ name: "session", sessionId: props.sessionId })}
        >
          ←
        </button>
        <span class="session-cwd" title={sessionTitle()}>
          {sessionTitle() ?? "Subagent"}
        </span>
        <span class="subagent-id badge">{props.agentId.slice(0, 8)}</span>
        <Show when={header().model !== undefined}>
          <span class="session-permission-mode">{header().model}</span>
        </Show>
        <Show when={header().tokenTotal > 0}>
          <span class="context-stats">{formatTokens(header().tokenTotal)} tokens</span>
        </Show>
        <Show when={header().todo}>
          {(todo) => (
            <span class="context-stats">
              todo {todo().completed}/{todo().total}
            </span>
          )}
        </Show>
      </header>
      <div class="subagent-body">
        <Show when={loading()}>
          <div class="loading-hint">Loading transcript…</div>
        </Show>
        <Show when={error() !== undefined}>
          <div class="message-error">{error()}</div>
        </Show>
        <Show when={!loading() && messages().length === 0 && error() === undefined}>
          <div class="loading-hint">No transcript available</div>
        </Show>
        <Show when={messages().length > 0}>
          <Transcript
            store={props.store}
            sessionId={props.sessionId}
            messages={messages() as Message[]}
            status={{ type: "idle" }}
            onEdit={() => {}}
          />
        </Show>
      </div>
    </div>
  )
}

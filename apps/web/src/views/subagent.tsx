import { createEffect, createSignal, For, Show } from "solid-js"
import { api } from "../api"
import { navigate } from "../app"
import type { WebStore } from "../store"
import { renderMarkdown } from "../utils/markdown"
import { deriveSubagentHeader } from "../utils/subagent"

type TranscriptBlock = {
  readonly type?: string
  readonly text?: string
  readonly name?: string
  readonly input?: unknown
  readonly content?: readonly unknown[]
}

type TranscriptMessage = {
  readonly role?: string
  readonly message?: {
    readonly role?: string
    readonly content?: readonly TranscriptBlock[]
    readonly model?: string
  }
  readonly type?: string
  readonly subtype?: string
  readonly cwd?: string
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`
  return `${total}`
}

function blockText(block: TranscriptBlock): string {
  if (block.type === "text" && typeof block.text === "string") return block.text
  if (block.type === "tool_use") {
    const name = block.name ?? "tool"
    return `[${name}] ${JSON.stringify(block.input ?? {})}`
  }
  if (block.type === "tool_result") {
    const content = block.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (c === null || typeof c !== "object") return String(c)
          const b = c as { text?: string }
          return typeof b.text === "string" ? b.text : ""
        })
        .join("\n")
    }
    return JSON.stringify(content)
  }
  return ""
}

export function SubagentView(props: {
  readonly store: WebStore
  readonly sessionId: string
  readonly agentId: string
}) {
  const [messages, setMessages] = createSignal<readonly TranscriptMessage[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | undefined>(undefined)

  createEffect(() => {
    let cancelled = false
    setMessages([])
    setError(undefined)
    setLoading(true)
    void (async () => {
      try {
        const data = await api.getSubagent(props.sessionId, props.agentId)
        if (cancelled) return
        setMessages((data.messages ?? []) as TranscriptMessage[])
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  })

  const header = () => deriveSubagentHeader(messages() as unknown[])

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
        <span class="session-cwd">Subagent</span>
        <span class="subagent-id badge">{props.agentId}</span>
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
        <For each={messages()}>
          {(message) => (
            <div class={`subagent-message ${message.role === "user" ? "user" : "assistant"}`}>
              <div class="message-role">{message.role === "user" ? "User" : "Wren"}</div>
              <div class="message-body">
                <For each={message.message?.content ?? []}>
                  {(block) => (
                    <div>
                      {block.type === "text" && (
                        <div class="markdown" innerHTML={renderMarkdown(block.text ?? "")} />
                      )}
                      {block.type !== "text" && <pre class="json-block">{blockText(block)}</pre>}
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

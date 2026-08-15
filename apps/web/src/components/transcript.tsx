import type { Message, Part } from "@wren/protocol"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { WebStore } from "../store"
import { parseCompactSummaryText } from "../utils/folds"
import { renderMarkdown } from "../utils/markdown"
import { formatClock } from "../utils/time"
import { ToolCallCard } from "./tool-call"

function Markdown(props: { readonly text: string; readonly class?: string }) {
  const html = createMemo(() => renderMarkdown(props.text))
  return <div class={`markdown ${props.class ?? ""}`} innerHTML={html()} />
}

function Fold(props: {
  readonly label: string
  readonly summary: string
  readonly children: unknown
}) {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <div class="fold">
      <button type="button" class="fold-toggle" onClick={() => setExpanded((prev) => !prev)}>
        <span class="fold-arrow">{expanded() ? "▾" : "▸"}</span>
        {props.label}
      </button>
      <Show when={expanded()}>
        <div class="fold-body">
          <Markdown text={props.summary} />
        </div>
      </Show>
    </div>
  )
}

function CompactSummaryPart(props: { readonly text: string }) {
  const parsed = createMemo(() => parseCompactSummaryText(props.text))
  return (
    <Show when={parsed()}>
      {(value) => (
        <div class="compact-summary">
          <Show when={value().notification !== ""}>
            <Markdown text={value().notification} />
          </Show>
          <Fold label="Compaction Summary" summary={value().summary}>
            {null}
          </Fold>
        </div>
      )}
    </Show>
  )
}

function ThinkingPart(props: { readonly part: Extract<Part, { type: "thinking" }> }) {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <div class="thinking">
      <button type="button" class="fold-toggle" onClick={() => setExpanded((prev) => !prev)}>
        <span class="fold-arrow">{expanded() ? "▾" : "▸"}</span>
        <span class="thinking-label">Thinking</span>
      </button>
      <Show when={expanded()}>
        <div class="thinking-body">
          <Markdown text={props.part.text} />
        </div>
      </Show>
    </div>
  )
}

function ToolResultPart(props: { readonly part: Extract<Part, { type: "tool_result" }> }) {
  const content = () => {
    const c = props.part.content
    if (typeof c === "string") return c
    if (Array.isArray(c)) {
      return c
        .map((block) => {
          if (block === null || typeof block !== "object") return String(block)
          const b = block as { type?: string; text?: string }
          if (b.type === "text" && typeof b.text === "string") return b.text
          return JSON.stringify(b)
        })
        .join("\n")
    }
    return JSON.stringify(c)
  }
  return (
    <div class="tool-result">
      <pre>{content()}</pre>
    </div>
  )
}

function UserMessageView(props: {
  readonly message: Message
  readonly onEdit: (message: Message) => void
}) {
  return (
    <div class="message user">
      <div class="message-role">
        You <span class="message-time">{formatClock(props.message.createdAt)}</span>
        <button
          type="button"
          class="message-edit"
          title="Edit and resend"
          onClick={() => props.onEdit(props.message)}
        >
          ✎ edit
        </button>
      </div>
      <div class="message-body">
        <For each={props.message.parts}>
          {(part) => (
            <Show when={part.type === "text"}>
              <Markdown text={(part as Extract<Part, { type: "text" }>).text} />
            </Show>
          )}
        </For>
      </div>
    </div>
  )
}

function AssistantMessageView(props: { readonly message: Message; readonly streaming: boolean }) {
  return (
    <div class="message assistant">
      <div class="message-role">Wren <span class="message-time">{formatClock(props.message.createdAt)}</span></div>
      <div class="message-body">
        <Show when={props.message.error !== undefined}>
          <div class="message-error">Error: {props.message.error}</div>
        </Show>
        <For each={props.message.parts}>
          {(part) => (
            <>
              {part.type === "text" &&
                (parseCompactSummaryText(part.text) !== null ? (
                  <CompactSummaryPart text={part.text} />
                ) : (
                  <Markdown text={part.text} />
                ))}
              {part.type === "thinking" && <ThinkingPart part={part} />}
              {part.type === "tool_use" && <ToolCallCard part={part} />}
              {part.type === "tool_result" && <ToolResultPart part={part} />}
            </>
          )}
        </For>
        <Show when={props.streaming}>
          <span class="streaming-cursor" />
        </Show>
      </div>
    </div>
  )
}

function SystemMessageView(props: { readonly message: Message }) {
  const text = createMemo(() =>
    props.message.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  )
  return (
    <Show when={text().trim() !== ""}>
      <div class="message system">
        <span class="message-role">system</span>
        <div class="message-body">{text()}</div>
      </div>
    </Show>
  )
}

export function Transcript(props: {
  readonly store: WebStore
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly status: { readonly type: string }
  readonly onEdit: (message: Message) => void
}) {
  return (
    <div class="transcript">
      <For each={props.messages}>
        {(message) => (
          <>
            {message.role === "user" && <UserMessageView message={message} onEdit={props.onEdit} />}
            {message.role === "assistant" && (
              <AssistantMessageView
                message={message}
                streaming={
                  props.status.type === "working" &&
                  message === props.messages[props.messages.length - 1]
                }
              />
            )}
            {message.role === "system" && <SystemMessageView message={message} />}
          </>
        )}
      </For>
    </div>
  )
}

import type { Message } from "@wren/protocol"
import { createEffect, createSignal, onMount, Show } from "solid-js"
import { api } from "../api"
import type { WebStore } from "../store"
import { messageText } from "../utils/folds"

const HISTORY_KEY = "wren-prompt-history"

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[]
  } catch {
    return []
  }
}

export function PromptBox(props: {
  readonly store: WebStore
  readonly sessionId: string
  readonly busy: boolean
  readonly editingMessage: Message | undefined
  readonly onDoneEditing: () => void
}) {
  const [value, setValue] = createSignal("")
  const [history, setHistory] = createSignal<string[]>(loadHistory())
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  let textareaRef: HTMLTextAreaElement | undefined

  onMount(() => {
    if (!props.busy) textareaRef?.focus()
  })

  // When an edit starts, load the message text into the box.
  createEffect(() => {
    const message = props.editingMessage
    if (message !== undefined) {
      setValue(messageText(message.parts))
      setError(undefined)
    }
  })

  function autoResize(): void {
    const el = textareaRef
    if (el === undefined) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  async function send(): Promise<void> {
    const prompt = value().trim()
    if (prompt === "" || sending()) return
    setSending(true)
    setError(undefined)
    try {
      await api.sendMessage(props.sessionId, prompt, props.editingMessage?.id)
      // Record prompt history on successful dispatch.
      const next = [prompt, ...history().filter((h) => h !== prompt)].slice(0, 50)
      setHistory(next)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {
        // storage unavailable
      }
      setValue("")
      setHistoryIndex(-1)
      props.onDoneEditing()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void send()
      return
    }
    if (event.key === "ArrowUp" && value() === "" && history().length > 0) {
      event.preventDefault()
      const next = Math.min(historyIndex() + 1, history().length - 1)
      setHistoryIndex(next)
      setValue(history()[history().length - 1 - next] ?? "")
      return
    }
    if (event.key === "ArrowDown" && historyIndex() >= 0) {
      event.preventDefault()
      const next = historyIndex() - 1
      setHistoryIndex(next)
      setValue(next < 0 ? "" : (history()[history().length - 1 - next] ?? ""))
      return
    }
    if (event.key === "Escape" && props.editingMessage !== undefined) {
      event.preventDefault()
      setValue("")
      props.onDoneEditing()
    }
  }

  return (
    <div class="prompt-box">
      <Show when={props.editingMessage !== undefined}>
        <div class="prompt-edit-banner">
          <span>Editing message — resend to apply changes</span>
          <button
            type="button"
            class="icon-btn"
            onClick={() => {
              setValue("")
              props.onDoneEditing()
            }}
          >
            ×
          </button>
        </div>
      </Show>
      <Show when={error() !== undefined}>
        <div class="prompt-error">{error()}</div>
      </Show>
      <div class="prompt-row">
        <textarea
          ref={textareaRef}
          class="prompt-input"
          placeholder={
            props.busy
              ? "Agent is working…"
              : "Send a message (Enter to send, Shift+Enter for newline)"
          }
          value={value()}
          onInput={(event) => {
            setValue(event.currentTarget.value)
            autoResize()
          }}
          onKeyDown={onKeyDown}
          disabled={props.busy && props.editingMessage === undefined}
        />
        <button
          type="button"
          class="btn primary prompt-send"
          onClick={() => void send()}
          disabled={value().trim() === "" || sending()}
        >
          {props.busy ? "Queued" : "Send"}
        </button>
      </div>
    </div>
  )
}

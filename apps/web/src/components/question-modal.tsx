import type { QuestionRequest } from "@wren/protocol"
import { createSignal, For, Show } from "solid-js"
import { api } from "../api"
import { useBodyScrollLock } from "../utils/escape"

export function QuestionModal(props: {
  readonly sessionId: string
  readonly request: QuestionRequest
}) {
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [custom, setCustom] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  useBodyScrollLock()

  const multi = () => props.request.multiSelect ?? false

  function toggleOption(id: string): void {
    if (multi()) {
      const next = new Set(selected())
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
    } else {
      setSelected(new Set([id]))
    }
  }

  async function submit(rejected: boolean): Promise<void> {
    if (busy()) return
    const answers = rejected
      ? []
      : [...selected()]
          .map((id) => {
            const option = props.request.options.find((o) => o.id === id)
            return option?.label ?? id
          })
          .concat(custom().trim() !== "" ? [custom().trim()] : [])
    if (!rejected && answers.length === 0) {
      setError("select at least one option")
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await api.respondQuestion(props.sessionId, props.request.id, answers, rejected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">{props.request.title}</span>
        </div>
        <div class="modal-body">
          <Show when={props.request.detail !== ""}>
            <p class="question-detail">{props.request.detail}</p>
          </Show>
          <div class="question-options">
            <For each={props.request.options}>
              {(option) => (
                <button
                  type="button"
                  classList={{ "question-option-selected": selected().has(option.id) }}
                  class="question-option"
                  onClick={() => toggleOption(option.id)}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
          <input
            class="search-input question-custom"
            type="text"
            placeholder="Custom answer…"
            value={custom()}
            onInput={(event) => setCustom(event.currentTarget.value)}
          />
          <Show when={error() !== undefined}>
            <div class="prompt-error">{error()}</div>
          </Show>
        </div>
        <div class="modal-footer">
          <button
            type="button"
            class="btn danger"
            disabled={busy()}
            onClick={() => void submit(true)}
          >
            Reject
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={busy()}
            onClick={() => void submit(false)}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  )
}

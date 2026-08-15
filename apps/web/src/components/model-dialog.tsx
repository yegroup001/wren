import type { ModelCatalogEntry } from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { api } from "../api"
import { useBodyScrollLock, useEscape } from "../utils/escape"

type DisplayEntry = {
  readonly id: string
  readonly name: string
  readonly providerLabel: string
  readonly contextLimit: number
}

function toDisplayEntry(entry: ModelCatalogEntry): DisplayEntry {
  const sourceName = entry.sourceName
  const label =
    sourceName ??
    entry.providerName ??
    entry.baseUrl ??
    (entry.ref.providerId === "openai-compatible" ||
    entry.ref.providerId === "openai-compatible-chat"
      ? "OpenAI-compatible"
      : entry.ref.providerId)
  return {
    id: sourceName === undefined ? entry.ref.modelId : `${sourceName}/${entry.ref.modelId}`,
    name: entry.ref.displayName ?? entry.ref.modelId,
    providerLabel: label,
    contextLimit: entry.contextLimit ?? 0,
  }
}

export function ModelDialog(props: {
  readonly sessionId: string
  readonly currentModel: string
  readonly onClose: () => void
}) {
  const [entries, setEntries] = createSignal<readonly DisplayEntry[]>([])
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(props.currentModel)
  const [effort, setEffort] = createSignal<string>("default")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  useEscape(props.onClose)
  useBodyScrollLock()

  createEffect(() => {
    void api
      .getModels()
      .then((body) => setEntries(body.entries.map(toDisplayEntry)))
      .catch(() => {})
  })

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    const all = entries()
    if (needle === "") return all
    return all.filter(
      (entry) =>
        entry.id.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle),
    )
  })

  async function apply(): Promise<void> {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.setModel(props.sessionId, selected())
      if (effort() !== "default") {
        await api.setEffort(
          props.sessionId,
          effort() as "low" | "medium" | "high" | "xhigh" | "max",
        )
      }
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <span class="modal-title">Model</span>
          <button type="button" class="icon-btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          <input
            class="search-input question-custom"
            type="search"
            placeholder="Search models…"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
          <div class="model-list">
            <For each={filtered()}>
              {(entry) => (
                <button
                  type="button"
                  classList={{ "model-row-selected": selected() === entry.id }}
                  class="model-row"
                  onClick={() => setSelected(entry.id)}
                >
                  <span class="model-row-id">{entry.id}</span>
                  <span class="model-row-meta">
                    {entry.providerLabel}
                    {entry.contextLimit > 0 ? ` · ${(entry.contextLimit / 1000).toFixed(0)}k` : ""}
                  </span>
                </button>
              )}
            </For>
            <Show when={filtered().length === 0}>
              <div class="sidebar-empty">No models match</div>
            </Show>
          </div>
          <label class="modal-label" for="effort-select">
            Reasoning effort
          </label>
          <select
            id="effort-select"
            class="select-input"
            value={effort()}
            onChange={(event) => setEffort(event.currentTarget.value)}
          >
            <option value="default">default</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
          <Show when={error() !== undefined}>
            <div class="prompt-error">{error()}</div>
          </Show>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn primary" disabled={busy()} onClick={() => void apply()}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

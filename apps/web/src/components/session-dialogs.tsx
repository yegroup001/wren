import type { Session } from "@wren/protocol"
import { createSignal, Show } from "solid-js"
import { api } from "../api"

export function RenameDialog(props: {
  readonly session: Session
  readonly currentTitle: string | undefined
  readonly onClose: () => void
}) {
  const [value, setValue] = createSignal(props.currentTitle ?? props.session.cwd)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  async function save(): Promise<void> {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.renameSession(props.session.id, value().trim())
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div
      class="modal-overlay"
      onClick={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose()
      }}
    >
      <div
        class="modal"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div class="modal-header">
          <span class="modal-title">Rename session</span>
          <button type="button" class="icon-btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          <input
            class="search-input question-custom"
            type="text"
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save()
            }}
          />
          <Show when={error() !== undefined}>
            <div class="prompt-error">{error()}</div>
          </Show>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn primary" disabled={busy()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export function GoalDialog(props: { readonly sessionId: string; readonly onClose: () => void }) {
  const [objective, setObjective] = createSignal("")
  const [goal, setGoal] = createSignal<{ objective: string; maxTurns?: number } | undefined>(
    undefined,
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  async function refresh(): Promise<void> {
    try {
      const status = await api.getGoalStatus(props.sessionId)
      if (status.goal !== null && status.goal !== undefined) {
        setGoal({
          objective: status.goal.objective,
          ...(status.goal.maxTurns !== undefined && { maxTurns: status.goal.maxTurns }),
        })
      }
    } catch {
      // goal status may be unsupported — ignore
    }
  }

  void refresh()

  async function setGoalValue(): Promise<void> {
    if (busy() || objective().trim() === "") return
    setBusy(true)
    setError(undefined)
    try {
      await api.setGoal(props.sessionId, "set", objective().trim())
      setObjective("")
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function clearGoal(): Promise<void> {
    if (busy()) return
    setBusy(true)
    try {
      await api.setGoal(props.sessionId, "clear")
      setGoal(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      class="modal-overlay"
      onClick={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose()
      }}
    >
      <div
        class="modal"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div class="modal-header">
          <span class="modal-title">Goal</span>
          <button type="button" class="icon-btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          <Show when={goal()}>
            {(current) => (
              <div class="current-goal">
                <span class="modal-label">Current goal</span>
                <p>{current().objective}</p>
                <Show when={current().maxTurns !== undefined}>
                  <span class="context-stats">max {current().maxTurns} turns</span>
                </Show>
              </div>
            )}
          </Show>
          <input
            class="search-input question-custom"
            type="text"
            placeholder="New objective…"
            value={objective()}
            onInput={(event) => setObjective(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void setGoalValue()
            }}
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
            onClick={() => void clearGoal()}
          >
            Clear
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={busy()}
            onClick={() => void setGoalValue()}
          >
            Set
          </button>
        </div>
      </div>
    </div>
  )
}

export function StatusDialog(props: { readonly sessionId: string; readonly onClose: () => void }) {
  const [context, setContext] = createSignal<
    { messageCount: number; totalChars: number; estimatedTokens: number } | undefined
  >(undefined)

  void api
    .getContext(props.sessionId)
    .then(setContext)
    .catch(() => {})

  return (
    <div
      class="modal-overlay"
      onClick={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose()
      }}
    >
      <div
        class="modal"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div class="modal-header">
          <span class="modal-title">Status</span>
          <button type="button" class="icon-btn" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          <Show when={context()}>
            {(stats) => (
              <dl class="status-list">
                <dt>Messages</dt>
                <dd>{stats().messageCount}</dd>
                <dt>Context chars</dt>
                <dd>{stats().totalChars.toLocaleString()}</dd>
                <dt>Estimated tokens</dt>
                <dd>{stats().estimatedTokens.toLocaleString()}</dd>
              </dl>
            )}
          </Show>
          <Show when={context() === undefined}>
            <div class="sidebar-empty">Context stats unavailable</div>
          </Show>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

import type { Session } from "@wren/protocol"
import { createMemo, createSignal, For, Show } from "solid-js"
import { api, previewFor } from "../api"
import { navigate } from "../app"
import type { WebStore } from "../store"
import { useEscape } from "../utils/escape"
import { formatTime } from "../utils/time"

export function HomeView(props: { readonly store: WebStore }) {
  const [query, setQuery] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [cwd, setCwd] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [renaming, setRenaming] = createSignal<Session | undefined>(undefined)
  const [renameValue, setRenameValue] = createSignal("")

  const filtered = createMemo(() => {
    const q = query().toLowerCase()
    const sessions = props.store.state.sessions
    if (q === "") return sessions
    return sessions.filter(
      (session) =>
        session.cwd.toLowerCase().includes(q) || session.modelId.toLowerCase().includes(q),
    )
  })

  async function createSession(): Promise<void> {
    if (cwd().trim() === "") {
      setError("workspace path is required")
      return
    }
    setError(undefined)
    try {
      const session = await api.createSession({ cwd: cwd().trim() })
      navigate({ name: "session", sessionId: session.id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function removeSession(session: Session): Promise<void> {
    if (!window.confirm(`Delete session ${session.id}?`)) return
    try {
      await api.deleteSession(session.id)
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div class="home-view">
      <div class="home-toolbar">
        <input
          class="search-input"
          type="search"
          placeholder="Search sessions…"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button type="button" class="btn primary" onClick={() => setCreating(!creating())}>
          New session
        </button>
      </div>

      <Show when={creating()}>
        <div class="new-session-form">
          <input
            class="search-input"
            type="text"
            placeholder="Workspace path, e.g. /home/user/project"
            value={cwd()}
            onInput={(event) => setCwd(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createSession()
            }}
          />
          <button type="button" class="btn" onClick={() => void createSession()}>
            Create
          </button>
          <Show when={error() !== undefined}>
            <span class="form-error">{error()}</span>
          </Show>
        </div>
      </Show>

      <ul class="session-list">
        <For each={filtered()}>
          {(session) => (
            <li class="session-row">
              <button
                type="button"
                class="session-row-main"
                onClick={() => navigate({ name: "session", sessionId: session.id })}
              >
                <span class="session-row-cwd">
                  {props.store.state.titles[session.id] ?? session.cwd}
                </span>
                <span class="session-row-model">{session.modelId}</span>
                <Show when={previewFor(session.id, props.store.state.previews) !== undefined}>
                  <span class="session-row-preview">
                    {previewFor(session.id, props.store.state.previews)}
                  </span>
                </Show>
              </button>
              <span class="session-row-meta">
                {formatTime(props.store.state.previews[session.id]?.createdAt)}
              </span>
              <button
                type="button"
                class="icon-btn"
                title="Rename session"
                onClick={() => {
                  setRenameValue(props.store.state.titles[session.id] ?? session.cwd)
                  setRenaming(session)
                }}
              >
                ✎
              </button>
              <button
                type="button"
                class="icon-btn"
                title="Delete session"
                onClick={() => void removeSession(session)}
              >
                ×
              </button>
            </li>
          )}
        </For>
      </ul>

      <Show when={renaming() !== undefined}>
        <RenameModal
          session={renaming()!}
          value={renameValue()}
          onValue={setRenameValue}
          onClose={() => setRenaming(undefined)}
        />
      </Show>
    </div>
  )
}

function RenameModal(props: {
  readonly session: Session
  readonly value: string
  readonly onValue: (v: string) => void
  readonly onClose: () => void
}) {
  useEscape(props.onClose)
  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
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
            value={props.value}
            onInput={(e) => props.onValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void api.renameSession(props.session.id, props.value.trim())
                props.onClose()
              }
            }}
          />
        </div>
        <div class="modal-footer">
          <button
            type="button"
            class="btn primary"
            onClick={() => {
              void api.renameSession(props.session.id, props.value.trim())
              props.onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

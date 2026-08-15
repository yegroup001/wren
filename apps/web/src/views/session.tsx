import type {
  Diff,
  Message,
  PermissionRequest,
  QuestionRequest,
  Session,
  Todo,
} from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { api } from "../api"
import { navigate } from "../app"
import { DiffPanel } from "../components/diff-panel"
import { ModelDialog } from "../components/model-dialog"
import { PermissionModal } from "../components/permission-modal"
import { PromptBox } from "../components/prompt"
import { QuestionModal } from "../components/question-modal"
import { GoalDialog, RenameDialog, StatusDialog } from "../components/session-dialogs"
import { SubagentPanel } from "../components/subagent-panel"
import { TodoList } from "../components/todo-list"
import { Transcript } from "../components/transcript"
import type { WebStore } from "../store"
import { useSubagentIds } from "../utils/subagent"

function StatusBadge(props: { readonly status: SessionStatusLike }) {
  const label = () =>
    props.status.type === "working"
      ? `working${props.status.model !== undefined ? ` · ${props.status.model}` : ""}`
      : props.status.type === "retry"
        ? `retry ${props.status.attempt}/${props.status.maxRetries}`
        : props.status.type
  const className = () => `status-badge ${props.status.type}`
  return <span class={className()}>{label()}</span>
}

type SessionStatusLike = {
  readonly type: string
  readonly model?: string
  readonly attempt?: number
  readonly maxRetries?: number
}

export function SessionView(props: { readonly store: WebStore; readonly sessionId: string }) {
  const sid = props.sessionId
  const session = (): Session | undefined => props.store.state.sessions.find((s) => s.id === sid)
  const messages = (): Message[] => props.store.state.messages[sid] ?? []
  const status = (): SessionStatusLike => props.store.state.status[sid] ?? { type: "idle" }
  const permissions = (): PermissionRequest[] => props.store.state.permissions[sid] ?? []
  const questions = (): QuestionRequest[] => props.store.state.questions[sid] ?? []
  const todos = (): Todo[] => props.store.state.todos[sid] ?? []
  const diff = (): Diff | undefined => props.store.state.diffs[sid]
  const compactProgress = () => props.store.state.compactProgress[sid]

  const [hydrated, setHydrated] = createSignal(false)
  const [contextStats, setContextStats] = createSignal<
    { messageCount: number; totalChars: number; estimatedTokens: number } | undefined
  >(undefined)
  const [showModelDialog, setShowModelDialog] = createSignal(false)
  const [showRenameDialog, setShowRenameDialog] = createSignal(false)
  const [showGoalDialog, setShowGoalDialog] = createSignal(false)
  const [showStatusDialog, setShowStatusDialog] = createSignal(false)
  const [sidebarTab, setSidebarTab] = createSignal<"todos" | "changes" | "subagents">("todos")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [editingMessage, setEditingMessage] = createSignal<Message | undefined>(undefined)

  const subagentIds = createMemo(() => useSubagentIds(messages()))
  const activePermission = createMemo(() => {
    const list = permissions()
    return list.length > 0 ? (list[list.length - 1] ?? list[0]) : undefined
  })
  const activeQuestion = createMemo(() => {
    const list = questions()
    return list.length > 0 ? (list[list.length - 1] ?? list[0]) : undefined
  })

  onMount(() => {
    if (messages().length === 0) {
      void api
        .getMessages<Message>(sid)
        .then((loaded) => {
          props.store.apply({
            messages: [{ sessionId: sid, mode: "replaceAll", messages: loaded }],
          })
        })
        .catch(() => {})
        .finally(() => setHydrated(true))
    } else {
      setHydrated(true)
    }
    void api
      .getContext(sid)
      .then(setContextStats)
      .catch(() => {})
  })

  // Keep the transcript scrolled to the bottom while the agent is working
  // unless the user scrolled up.
  let transcriptRef: HTMLDivElement | undefined
  const [stickToBottom, setStickToBottom] = createSignal(true)

  function onTranscriptScroll(): void {
    const el = transcriptRef
    if (el === undefined) return
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  createEffect(() => {
    void messages()
    void status()
    const el = transcriptRef
    if (el !== undefined && stickToBottom()) el.scrollTop = el.scrollHeight
  })


  const busy = () => status().type !== "idle"
  const title = () => props.store.state.titles[sid]

  async function exportSession(): Promise<void> {
    try {
      const text = await api.getExportText(sid)
      const blob = new Blob([text], { type: "text/markdown" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${title() ?? session()?.cwd ?? "session"}.md`
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div class="session-view">
      <header class="session-header">
        <button type="button" class="nav-home" onClick={() => navigate({ name: "home" })}>
          ←
        </button>
        <span class="session-cwd" title={session()?.cwd}>
          {title() ?? session()?.cwd}
        </span>
        <button type="button" class="btn ghost" onClick={() => setShowModelDialog(true)}>
          {session()?.modelId ?? "model"}
        </button>
        <select
          class="permission-select"
          value={session()?.permissionMode ?? "default"}
          onChange={(event) => {
            const mode = event.currentTarget.value
            if (session() !== undefined) void api.setPermissionMode(sid, mode)
          }}
          title="Permission mode"
        >
          <option value="auto">auto</option>
          <option value="default">default</option>
          <option value="full">full</option>
          <option value="plan">plan</option>
        </select>
        <StatusBadge status={status()} />
        <Show when={contextStats()}>
          {(stats) => (
            <span class="context-stats" title="context usage">
              {stats().estimatedTokens} tokens
            </span>
          )}
        </Show>
        <span class="app-header-spacer" />
        <button
          type="button"
          class="header-action"
          title="Rename session"
          onClick={() => setShowRenameDialog(true)}
        >
          Rename
        </button>
        <button
          type="button"
          class="header-action"
          title="Session goal"
          onClick={() => setShowGoalDialog(true)}
        >
          Goal
        </button>
        <button
          type="button"
          class="header-action"
          title="Export conversation as markdown"
          onClick={() => void exportSession()}
        >
          Export
        </button>
        <button
          type="button"
          class="header-action"
          title="Session status"
          onClick={() => setShowStatusDialog(true)}
        >
          Status
        </button>
        <button
          type="button"
          class="header-action"
          disabled={busy() || messages().length === 0}
          title="Retry the last turn"
          onClick={() => void api.retry(sid)}
        >
          Retry
        </button>
        <button
          type="button"
          class="header-action danger-action"
          disabled={busy()}
          title="Clear the conversation"
          onClick={() => {
            if (window.confirm("Clear this session's messages?")) void api.clear(sid)
          }}
        >
          Clear
        </button>
        <Show when={busy()}>
          <button type="button" class="btn danger" onClick={() => void api.abort(sid)}>
            Abort
          </button>
        </Show>
        <button
          type="button"
          class="header-action sidebar-toggle"
          title="Toggle panels"
          onClick={() => setSidebarOpen((prev) => !prev)}
        >
          Panels
        </button>
      </header>

      <div class="session-body">
        <div class="transcript-scroll" ref={transcriptRef} onScroll={onTranscriptScroll}>
          <Show when={!hydrated()}>
            <div class="loading-hint">Loading session…</div>
          </Show>
          <Show when={compactProgress()}>
            {(progress) => <CompactProgressBanner progress={progress()} />}
          </Show>
          <Transcript
            store={props.store}
            sessionId={sid}
            messages={messages()}
            status={status()}
            onEdit={setEditingMessage}
          />
        </div>

        <aside classList={{ "sidebar-open": sidebarOpen() }} class="session-sidebar">
          <div class="sidebar-tabs">
            <button
              type="button"
              classList={{ "tab-active": sidebarTab() === "todos" }}
              class="tab"
              onClick={() => setSidebarTab("todos")}
            >
              Todos
            </button>
            <button
              type="button"
              classList={{ "tab-active": sidebarTab() === "changes" }}
              class="tab"
              onClick={() => setSidebarTab("changes")}
            >
              Changes
            </button>
            <button
              type="button"
              classList={{ "tab-active": sidebarTab() === "subagents" }}
              class="tab"
              onClick={() => setSidebarTab("subagents")}
            >
              Agents
            </button>
          </div>
          <Show when={sidebarTab() === "todos"}>
            <TodoList todos={todos()} />
          </Show>
          <Show when={sidebarTab() === "changes"}>
            <DiffPanel diff={diff()} />
          </Show>
          <Show when={sidebarTab() === "subagents"}>
            <SubagentPanel
              sessionId={sid}
              agents={subagentIds()}
              onOpen={(agentId) => navigate({ name: "subagent", sessionId: sid, agentId })}
            />
          </Show>
        </aside>
      </div>

      <PromptBox
        store={props.store}
        sessionId={sid}
        busy={busy()}
        editingMessage={editingMessage()}
        onDoneEditing={() => setEditingMessage(undefined)}
      />

      <Show when={activePermission()}>
        {(request) => <PermissionModal sessionId={sid} request={request()} />}
      </Show>
      <Show when={activeQuestion()}>
        {(request) => <QuestionModal sessionId={sid} request={request()} />}
      </Show>
      <Show when={showModelDialog()}>
        <ModelDialog
          sessionId={sid}
          currentModel={session()?.modelId ?? ""}
          onClose={() => setShowModelDialog(false)}
        />
      </Show>
      <Show when={showRenameDialog() ? session() : undefined}>
        {(current) => (
          <RenameDialog
            session={current()}
            currentTitle={props.store.state.titles[sid]}
            onClose={() => setShowRenameDialog(false)}
          />
        )}
      </Show>
      <Show when={showGoalDialog()}>
        <GoalDialog sessionId={sid} onClose={() => setShowGoalDialog(false)} />
      </Show>
      <Show when={showStatusDialog()}>
        <StatusDialog sessionId={sid} onClose={() => setShowStatusDialog(false)} />
      </Show>
    </div>
  )
}

function CompactProgressBanner(props: {
  readonly progress: { phase: string; segments: readonly { type: string; text: string }[] }
}) {
  return (
    <div class="compact-progress">
      <span class="compact-progress-phase">Compacting ({props.progress.phase})</span>
      <For each={props.progress.segments}>
        {(segment) => <span class="compact-progress-text">{segment.text}</span>}
      </For>
    </div>
  )
}

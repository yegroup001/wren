/** @jsxImportSource @opentui/solid */

import { type Renderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import type { Todo } from "@wren/protocol"
import { createEffect, createMemo, createSignal, type JSX, Show, untrack } from "solid-js"
import { type CommandAction, CommandPalette } from "../components/command-palette"
import { DialogAgent } from "../components/dialog-agent"
import { DialogDoctor } from "../components/dialog-doctor"
import { DialogHelp } from "../components/dialog-help"
import { DialogHistorySearch } from "../components/dialog-history-search"
import { DialogModel } from "../components/dialog-model"
import { DialogSessionList } from "../components/dialog-session-list"
import { DialogSkills } from "../components/dialog-skills"
import { DialogStatus } from "../components/dialog-status"
import { DialogTheme } from "../components/dialog-theme"
import { DialogVariants } from "../components/dialog-variants"
import { DiffPanel } from "../components/diff-panel"
import { DiffViewer } from "../components/diff-viewer"
import { PermissionModal } from "../components/permission-modal"
import { Prompt } from "../components/prompt"
import { createPromptHistory } from "../components/prompt-history"
import { QuestionModal } from "../components/question-modal"
import { SubagentPanel } from "../components/subagent-panel"
import { TodoList } from "../components/todo-list"
import { Transcript } from "../components/transcript"
import { useDialog } from "../context/dialog"
import { useModal } from "../context/modal"
import { useRoute } from "../context/route"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useExternalEditor } from "../hooks/use-external-editor"
import { useBindings } from "../keymap"
import { useToast } from "../ui/toast"

function findScrollBox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node
  for (const child of node.getChildren()) {
    const found = findScrollBox(child)
    if (found !== undefined) return found
  }
  return undefined
}

export function Session(props: { sessionId: string }): JSX.Element {
  const store = useStore()
  const adapter = useAdapter()
  const toast = useToast()
  const dialog = useDialog()
  const { navigate } = useRoute()
  const { theme, themes, selected, set: setTheme } = useTheme()
  const renderer = useRenderer()
  const dims = useTerminalDimensions()

  const [messagesLoading, setMessagesLoading] = createSignal(
    untrack(() => store.store.messages[props.sessionId]) === undefined,
  )
  createEffect(() => {
    const sid = props.sessionId
    if (untrack(() => store.store.messages[sid]) !== undefined) return
    setMessagesLoading(true)
    void adapter
      .fetch(createWrenRequest(`/session/${sid}/messages`))
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load messages: ${res.status}`)
      })
      .catch((err) => {
        toast.error(err)
      })
      .finally(() => setMessagesLoading(false))
  })

  const todos = createMemo<Todo[]>(() => store.store.todos[props.sessionId] ?? [])
  const hasPendingPermission = createMemo(
    () => (store.store.permissions[props.sessionId]?.length ?? 0) > 0,
  )
  const session = createMemo(() => store.store.sessions.find((s) => s.id === props.sessionId))
  const hasPendingQuestion = createMemo(
    () => (store.store.questions[props.sessionId]?.length ?? 0) > 0,
  )
  const requestPending = createMemo(() => hasPendingPermission() || hasPendingQuestion())

  const [diffVisible, setDiffVisible] = createSignal(false)
  const [diffPanelVisible, setDiffPanelVisible] = createSignal(true)
  const modal = useModal()
  const [editText, setEditText] = createSignal("")
  const [editMessageId, setEditMessageId] = createSignal<string | undefined>()
  const [scrollToBottomTick, setScrollToBottomTick] = createSignal(0)
  const externalEditor = useExternalEditor()
  const history = createPromptHistory()

  const sidebarVisible = createMemo(() => dims().width >= 60)
  const sidebarWidth = createMemo(() => {
    const w = dims().width
    if (w < 100) return Math.max(20, Math.floor(w * 0.35))
    return Math.min(40, Math.floor(w * 0.3))
  })

  createEffect(() => {
    if (!requestPending()) return
    dialog.clear()
  })

  const modalActive = createMemo(
    () =>
      diffVisible() || modal.content() !== null || dialog.stack().length > 0 || requestPending(),
  )

  const anyDialogVisible = createMemo(
    () => diffVisible() || modal.content() !== null || dialog.stack().length > 0,
  )

  function togglePermission(): void {
    const current = session()?.permissionMode ?? "default"
    const next =
      current === "default"
        ? "plan"
        : current === "plan"
          ? "auto"
          : current === "auto"
            ? "acceptEdits"
            : current === "acceptEdits"
              ? "full"
              : "default"
    void adapter.fetch(
      createWrenRequest(`/session/${props.sessionId}/permission-mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionMode: next, source: "manual" }),
      }),
    )
    toast.show({
      title: "Permission mode",
      message: next === "auto" ? "classifier auto mode" : next,
      variant: next === "auto" ? "success" : "info",
    })
  }

  function cycleTheme(): void {
    const next = themes[(themes.indexOf(selected()) + 1) % themes.length]
    if (next !== undefined && setTheme(next)) {
      toast.show({ title: "Theme", message: next, variant: "info" })
    }
  }

  function scrollToBottom(): void {
    const sb = findScrollBox(renderer.root)
    if (sb !== undefined) sb.scrollTo(sb.scrollHeight)
  }

  async function renameCurrentSession(): Promise<void> {
    const titles = adapter.titles?.()
    const current = titles?.[props.sessionId] ?? props.sessionId
    const result = await dialog.prompt("Rename session", {
      description: "Enter a new name for this session",
      value: current,
    })
    if (result === undefined || result.trim() === "") return
    const res = await adapter.fetch(
      createWrenRequest(`/session/${props.sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: result.trim() }),
      }),
    )
    if (res.ok) {
      toast.show({ title: "Session renamed", message: result.trim(), variant: "success" })
    } else {
      toast.show({ title: "Rename failed", message: `(${res.status})`, variant: "error" })
    }
  }

  const commandActions = createMemo<CommandAction[]>(() => [
    {
      id: "toggle-diff",
      title: "Toggle diff panel",
      description: "Toggle inline file changes",
      keybinding: "<leader>d",
      category: "View",
      run: () => setDiffPanelVisible((v) => !v),
    },
    {
      id: "toggle-diff-viewer",
      title: "Toggle diff viewer",
      description: "View full file changes",
      keybinding: "<leader>v",
      category: "View",
      run: () => setDiffVisible((v) => !v),
    },
    {
      id: "select-model",
      title: "Choose model",
      description: "Browse and select a model",
      keybinding: "<leader>m",
      category: "Model",
      run: () =>
        modal.open(() => (
          <DialogModel sessionId={props.sessionId} visible={() => true} onClose={modal.close} />
        )),
    },
    {
      id: "session-list",
      title: "Session list",
      description: "Browse and resume sessions",
      keybinding: "<leader>l",
      category: "Session",
      run: () => modal.open(() => <DialogSessionList visible={() => true} onClose={modal.close} />),
    },
    {
      id: "command-palette",
      title: "Command palette",
      description: "Search all commands",
      keybinding: "Ctrl+P",
      category: "View",
      run: () =>
        modal.open(() => (
          <CommandPalette visible={() => true} onClose={modal.close} actions={commandActions} />
        )),
    },
    {
      id: "toggle-permission",
      title: "Toggle permission mode",
      description: "Cycle default/plan/auto",
      keybinding: "<leader>p",
      category: "Permissions",
      run: togglePermission,
    },
    {
      id: "rename-session",
      title: "Rename session",
      description: "Rename the current session",
      keybinding: "<leader>r",
      category: "Session",
      run: () => void renameCurrentSession(),
    },
    {
      id: "help",
      title: "Help",
      description: "Show keybindings",
      keybinding: "<leader>h",
      category: "View",
      run: () => modal.open(() => <DialogHelp visible={() => true} onClose={modal.close} />),
    },
    {
      id: "theme-picker",
      title: "Theme picker",
      description: "Browse and select a theme",
      keybinding: "<leader>t",
      category: "View",
      run: () => modal.open(() => <DialogTheme visible={() => true} onClose={modal.close} />),
    },
    {
      id: "agent-selector",
      title: "Agent selector",
      description: "Browse and select an agent",
      keybinding: "",
      category: "Model",
      run: () => modal.open(() => <DialogAgent visible={() => true} onClose={modal.close} />),
    },
    {
      id: "skills",
      title: "Skills & Commands",
      description: "Browse available skills",
      keybinding: "",
      category: "View",
      run: () => modal.open(() => <DialogSkills visible={() => true} onClose={modal.close} />),
    },
    {
      id: "history-search",
      title: "History search",
      description: "Search prompt history",
      keybinding: "Ctrl+R",
      category: "Input",
      run: () =>
        modal.open(() => (
          <DialogHistorySearch
            visible={() => true}
            onClose={modal.close}
            entries={() => history.entries()}
            onSelect={(text) => {
              setEditMessageId(undefined)
              setEditText(text)
            }}
          />
        )),
    },
    {
      id: "doctor",
      title: "Diagnostics",
      description: "Show config diagnostics",
      keybinding: "",
      category: "View",
      run: () => modal.open(() => <DialogDoctor visible={() => true} onClose={modal.close} />),
    },
    {
      id: "external-editor",
      title: "External editor",
      description: "Edit prompt in $EDITOR",
      keybinding: "<leader>e",
      category: "Input",
      run: () => void openExternalEditor(""),
    },
    {
      id: "abort",
      title: "Abort session",
      description: "Stop the current turn",
      keybinding: "Ctrl+C",
      category: "Session",
      run: () => {
        void adapter.fetch(
          createWrenRequest(`/session/${props.sessionId}/abort`, { method: "POST" }),
        )
        toast.show({ title: "Abort", message: "Sending interrupt...", variant: "info" })
      },
    },
  ])

  async function openExternalEditor(initialText: string): Promise<void> {
    try {
      const result = await externalEditor.open(initialText)
      if (!result.cancelled && result.text.trim().length > 0) {
        setEditMessageId(undefined)
        setEditText(result.text)
      }
    } catch (err) {
      toast.error(err)
    }
  }

  useBindings(() => ({
    enabled: !modalActive(),
    bindings: [
      {
        key: "<leader>d",
        desc: "Toggle diff panel",
        group: "Session",
        cmd: () => setDiffPanelVisible((v) => !v),
      },
      {
        key: "<leader>v",
        desc: "Toggle diff viewer",
        group: "Session",
        cmd: () => setDiffVisible((v) => !v),
      },
      {
        key: "<leader>m",
        desc: "Open model selector",
        group: "Session",
        cmd: () =>
          modal.open(() => (
            <DialogModel sessionId={props.sessionId} visible={() => true} onClose={modal.close} />
          )),
      },
      {
        key: "<leader>l",
        desc: "Open session list",
        group: "Session",
        cmd: () =>
          modal.open(() => <DialogSessionList visible={() => true} onClose={modal.close} />),
      },
      {
        key: "ctrl+p",
        desc: "Open command palette",
        group: "Session",
        cmd: () =>
          modal.open(() => (
            <CommandPalette visible={() => true} onClose={modal.close} actions={commandActions} />
          )),
      },
      { key: "<leader>p", desc: "Toggle permission mode", group: "Session", cmd: togglePermission },
      { key: "tab", desc: "Cycle permission mode", group: "Session", cmd: togglePermission },
      {
        key: "<leader>h",
        desc: "Show keybindings",
        group: "Session",
        cmd: () => modal.open(() => <DialogHelp visible={() => true} onClose={modal.close} />),
      },
      {
        key: "<leader>n",
        desc: "Back to home",
        group: "Session",
        cmd: () => navigate({ type: "home" }),
      },
      {
        key: "ctrl+n",
        desc: "Back to home",
        group: "Session",
        cmd: () => navigate({ type: "home" }),
      },
      { key: "<leader>t", desc: "Cycle theme", group: "Session", cmd: cycleTheme },
      { key: "<leader>g", desc: "Scroll to bottom", group: "Session", cmd: scrollToBottom },
      {
        key: "<leader>s",
        desc: "Show session status",
        group: "Session",
        cmd: () =>
          modal.open(() => (
            <DialogStatus visible={() => true} onClose={modal.close} sessionId={props.sessionId} />
          )),
      },
      {
        key: "<leader>r",
        desc: "Rename session",
        group: "Session",
        cmd: () => void renameCurrentSession(),
      },
      {
        key: "ctrl+r",
        desc: "History search",
        group: "Input",
        cmd: () =>
          modal.open(() => (
            <DialogHistorySearch
              visible={() => true}
              onClose={modal.close}
              entries={() => history.entries()}
              onSelect={(text) => {
                setEditMessageId(undefined)
                setEditText(text)
              }}
            />
          )),
      },
    ],
  }))
  return (
    <box flexDirection="row" flexGrow={1} minHeight={0} gap={0}>
      <box flexDirection="column" flexGrow={1} minWidth={0} gap={0}>
        <box
          flexGrow={1}
          minHeight={0}
          border
          borderStyle="single"
          borderColor={theme().border}
          overflow="hidden"
        >
          <Transcript
            sessionId={props.sessionId}
            modalActive={modalActive}
            scrollToBottomTick={scrollToBottomTick()}
            onEditMessage={(text, msgId) => {
              setEditMessageId(msgId)
              setEditText(text)
            }}
            loading={messagesLoading()}
          />
        </box>
        <box flexShrink={0}>
          <Prompt
            sessionId={props.sessionId}
            onOpenModelDialog={() =>
              modal.open(() => (
                <DialogModel
                  sessionId={props.sessionId}
                  visible={() => true}
                  onClose={modal.close}
                />
              ))
            }
            onOpenSessionList={() =>
              modal.open(() => <DialogSessionList visible={() => true} onClose={modal.close} />)
            }
            onOpenVariants={() =>
              modal.open(() => (
                <DialogVariants
                  sessionId={props.sessionId}
                  effort={() =>
                    store.store.sessions.find((s) => s.id === props.sessionId)?.effort ?? "default"
                  }
                  modelId={() =>
                    store.store.sessions.find((s) => s.id === props.sessionId)?.modelId
                  }
                  visible={() => true}
                  onClose={modal.close}
                />
              ))
            }
            onOpenHelp={() =>
              modal.open(() => <DialogHelp visible={() => true} onClose={modal.close} />)
            }
            onOpenTheme={() =>
              modal.open(() => <DialogTheme visible={() => true} onClose={modal.close} />)
            }
            onOpenDoctor={() =>
              modal.open(() => <DialogDoctor visible={() => true} onClose={modal.close} />)
            }
            onOpenAgents={() =>
              modal.open(() => <DialogAgent visible={() => true} onClose={modal.close} />)
            }
            onOpenSkills={() =>
              modal.open(() => <DialogSkills visible={() => true} onClose={modal.close} />)
            }
            onExternalEditor={(text) => openExternalEditor(text)}
            onSubmit={() => setScrollToBottomTick((t) => t + 1)}
            editText={editText()}
            editMessageId={editMessageId()}
            onEditTextConsumed={() => {
              setEditText("")
              setEditMessageId(undefined)
            }}
            inputDisabled={modalActive()}
            history={history}
          />
        </box>
      </box>
      <Show when={sidebarVisible()}>
        <box
          flexDirection="column"
          width={sidebarWidth()}
          flexShrink={0}
          border={["left"]}
          borderColor={theme().border}
          paddingLeft={1}
          paddingTop={1}
          gap={1}
        >
          <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
            <box flexDirection="row" gap={1} marginBottom={1}>
              <text fg={theme().accent}>{"\u25c7"}</text>
              <text fg={theme().primary} attributes={TextAttributes.BOLD}>
                TODO
              </text>
            </box>
            <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
              <Show
                when={todos().length > 0}
                fallback={<text fg={theme().textMuted}>No tasks</text>}
              >
                <TodoList todos={todos()} />
              </Show>
            </scrollbox>
          </box>
          <box
            flexDirection="column"
            flexGrow={1}
            flexBasis={0}
            minHeight={0}
            border={["top"]}
            borderColor={theme().border}
          >
            <box flexDirection="row" gap={1} marginBottom={1}>
              <text fg={theme().accent}>{"\u25c7"}</text>
              <text fg={theme().primary} attributes={TextAttributes.BOLD}>
                SUBAGENT
              </text>
            </box>
            <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
              <SubagentPanel sessionId={props.sessionId} />
            </scrollbox>
          </box>
          <box
            flexDirection="column"
            flexGrow={1}
            flexBasis={0}
            minHeight={0}
            border={["top"]}
            borderColor={theme().border}
          >
            <box flexDirection="row" gap={1} marginBottom={1}>
              <text fg={theme().accent}>{"\u25c7"}</text>
              <text fg={theme().primary} attributes={TextAttributes.BOLD}>
                CHANGES
              </text>
            </box>
            <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
              <Show
                when={diffPanelVisible()}
                fallback={<text fg={theme().textMuted}>No changes yet</text>}
              >
                <DiffPanel sessionId={props.sessionId} />
              </Show>
            </scrollbox>
          </box>
        </box>
      </Show>

      <PermissionModal sessionId={props.sessionId} deferred={anyDialogVisible} />
      <QuestionModal sessionId={props.sessionId} deferred={anyDialogVisible} />
      <DiffViewer
        sessionId={props.sessionId}
        visible={() => diffVisible()}
        onClose={() => setDiffVisible(false)}
      />
    </box>
  )
}

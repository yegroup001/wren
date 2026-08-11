import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { loadModelRegistry } from "@wren/config-node"
import { isModelCommand, parseModelCommand, parseSessionId, type Session } from "@wren/protocol"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { DialogModel } from "../components/dialog-model"
import { DialogSessionList } from "../components/dialog-session-list"
import { DialogSkills } from "../components/dialog-skills"
import { DialogVariants } from "../components/dialog-variants"
import {
  filterSlashCommands,
  isExactSlashCommand,
  PromptAutocomplete,
  shouldShowAutocomplete,
} from "../components/prompt-autocomplete"
import { promptTextareaKeyBindings } from "../components/prompt-keybindings"
import { PromptShell } from "../components/prompt-shell"
import { useLocal } from "../context/local"
import { useModal } from "../context/modal"
import { useRoute } from "../context/route"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useToast } from "../ui/toast"

const LOGO_LINES: readonly string[] = [
  "██╗    ██╗██████╗ ███████╗███╗   ██╗",
  "██║    ██║██╔══██╗██╔════╝████╗  ██║",
  "██║ █╗ ██║██████╔╝█████╗  ██╔██╗ ██║",
  "██║███╗██║██╔══██╗██╔══╝  ██║╚██╗██║",
  "╚███╔███╔╝██║  ██║███████╗██║ ╚████║",
  " ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝",
]

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function truncateModel(id: string, max: number): string {
  return id.length > max ? `${id.slice(0, max - 1)}…` : id
}

function truncatePathLeft(p: string, max: number): string {
  if (p.length <= max) return p
  if (max <= 1) return "…"
  return `…${p.slice(-(max - 1))}`
}

export function Home(): JSX.Element {
  const adapter = useAdapter()
  const store = useStore()
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const local = useLocal()
  const toast = useToast()
  const dims = useTerminalDimensions()

  const [text, setText] = createSignal("")
  const [selectedSession, setSelectedSession] = createSignal(0)
  const modal = useModal()
  const [autocompleteVisible, setAutocompleteVisible] = createSignal(false)
  const [permissionMode, setPermissionMode] = createSignal<
    "default" | "plan" | "auto" | "acceptEdits" | "full"
  >("auto")
  const [effort, setEffort] = createSignal("default")
  const [autocompleteIndex, setAutocompleteIndex] = createSignal(0)
  let textareaRef: TextareaRenderable | undefined

  const recentSessions = createMemo<Session[]>(() => store.store.sessions.slice(-5).reverse())
  const modalActive = createMemo(() => modal.content() !== null)

  const autocompleteOptions = createMemo(() => {
    if (!shouldShowAutocomplete(text())) return []
    const all = filterSlashCommands(text())
    const homeCommands = new Set(["models", "sessions", "mode", "variants", "help", "exit"])
    return all.filter((opt) => {
      const name = opt.value.trim().slice(1).split(" ")[0] ?? ""
      return homeCommands.has(name)
    })
  })

  function selectAutocomplete(): void {
    const selected = autocompleteOptions()[autocompleteIndex()]
    if (selected === undefined) return
    textareaRef?.setText(selected.value)
    setText(selected.value)
    setAutocompleteVisible(false)
    setAutocompleteIndex(0)
  }

  function onContentChange(): void {
    const t = textareaRef?.plainText ?? ""
    setText(t)
    setAutocompleteVisible(shouldShowAutocomplete(t))
    if (!shouldShowAutocomplete(t)) setAutocompleteIndex(0)
  }

  function onKeyDown(event: KeyEvent): void {
    const key = event.name.toLowerCase()
    if (!autocompleteVisible()) return
    if (key === "up") {
      event.preventDefault()
      const opts = autocompleteOptions()
      if (opts.length > 0) {
        setAutocompleteIndex((i) => (i - 1 + opts.length) % opts.length)
      }
      return
    }
    if (key === "down") {
      event.preventDefault()
      const opts = autocompleteOptions()
      if (opts.length > 0) {
        setAutocompleteIndex((i) => (i + 1) % opts.length)
      }
      return
    }
    if (key === "tab" || key === "return" || key === "kpenter") {
      event.preventDefault()
      const input = textareaRef?.plainText ?? text()
      if ((key === "return" || key === "kpenter") && isExactSlashCommand(input)) {
        setAutocompleteVisible(false)
        void submitPrompt(input)
        return
      }
      selectAutocomplete()
      if (key === "return" || key === "kpenter") {
        void submitPrompt(textareaRef?.plainText ?? text())
      }
      return
    }
    if (key === "escape") {
      event.preventDefault()
      setAutocompleteVisible(false)
      return
    }
  }

  function clearPrompt(): void {
    textareaRef?.clear()
    setText("")
  }

  async function submitPrompt(input: string): Promise<void> {
    const command = input.trim()
    if (isModelCommand(command)) {
      let cmd: ReturnType<typeof parseModelCommand>
      try {
        cmd = parseModelCommand(command)
      } catch (error) {
        toast.show({
          title: "Invalid model command",
          message: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        })
        return
      }
      if (cmd.verb === "open" || cmd.verb === "set" || cmd.verb === "manage") {
        textareaRef?.blur()
        clearPrompt()
        modal.open(() => <DialogModel visible={() => true} onClose={modal.close} />)
        return
      }
      if (cmd.verb === "status") {
        toast.show({ title: "Model status", message: `Current: ${local.model()}`, variant: "info" })
        clearPrompt()
        return
      }
      if (cmd.verb === "list") {
        const registry = loadModelRegistry(local.cwd())
        const names = registry.entries.map((e) => e.ref.modelId).join(", ")
        toast.show({ title: "Available models", message: names, variant: "info" })
        clearPrompt()
        return
      }
      clearPrompt()
      return
    }
    if (command === "/mode") {
      const current = permissionMode()
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
      setPermissionMode(next)
      clearPrompt()
      toast.show({
        title: "Permission mode",
        message: next === "auto" ? "classifier auto mode" : next,
        variant: next === "auto" ? "success" : "info",
      })
      return
    }
    if (command === "/variants") {
      clearPrompt()
      textareaRef?.blur()
      modal.open(() => (
        <DialogVariants
          effort={() => effort()}
          modelId={local.model}
          onSelect={(selected) => {
            setEffort(selected)
            toast.show({
              title: "Thinking effort",
              message: `${selected} for the next session`,
              variant: "success",
            })
          }}
          visible={() => true}
          onClose={modal.close}
        />
      ))
      return
    }
    if (command.startsWith("/variants ")) {
      const selected = command.slice("/variants ".length).trim().toLowerCase()
      if (["low", "medium", "high", "xhigh", "max"].includes(selected)) {
        setEffort(selected)
        clearPrompt()
        toast.show({
          title: "Thinking effort",
          message: `${selected} for the next session`,
          variant: "success",
        })
      } else {
        toast.show({
          title: "Invalid effort",
          message: "Choose: low, medium, high, xhigh, max",
          variant: "error",
        })
      }
      return
    }
    if (command === "/help") {
      clearPrompt()
      toast.show({
        title: "Home commands",
        message: "/models, /models <id>, /models status, /help, <leader>m, <leader>l",
        variant: "info",
      })
      return
    }
    if (command === "/sessions") {
      clearPrompt()
      textareaRef?.blur()
      modal.open(() => <DialogSessionList visible={() => true} onClose={modal.close} />)
      return
    }
    if (command === "/skills") {
      clearPrompt()
      textareaRef?.blur()
      modal.open(() => <DialogSkills visible={() => true} onClose={modal.close} />)
      return
    }
    if (command === "") return
    try {
      const body = {
        cwd: local.cwd(),
        modelId: local.model(),
        permissionMode: permissionMode(),
        effort: effort(),
      }
      const res = await adapter.fetch(
        createWrenRequest(`/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
      if (!res.ok) {
        let detail = `${res.status}`
        try {
          const body = await res.json()
          if (typeof body.message === "string") detail = body.message
        } catch {
          // body wasn't JSON — fall back to status code
        }
        toast.show({
          title: "Failed to create session",
          message: detail,
          variant: "error",
        })
        return
      }
      clearPrompt()
      const session = (await res.json()) as { id: string }
      const sessionId = parseSessionId(session.id)
      const msgRes = await adapter.fetch(
        createWrenRequest(`/session/${sessionId}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: command }),
        }),
      )
      if (!msgRes.ok) {
        let detail: string | undefined
        try {
          detail = ((await msgRes.json()) as { message?: string }).message
        } catch {
          detail = undefined
        }
        toast.show({
          title: "Failed to send message",
          message: detail !== undefined ? `${msgRes.status}: ${detail}` : `${msgRes.status}`,
          variant: "error",
        })
        return
      }
      navigate({ type: "session", sessionId })
    } catch (error) {
      toast.show({
        title: "Submit failed",
        message: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      })
    }
  }

  useKeyboard((key) => {
    if (modalActive()) return
    const currentText = textareaRef?.plainText ?? text()
    if (currentText.length > 0) return
    const sessions = recentSessions()
    if (sessions.length === 0) return
    const name = key.name
    if (name === "up") {
      setSelectedSession((v) => (v - 1 + sessions.length) % sessions.length)
    } else if (name === "down") {
      setSelectedSession((v) => (v + 1) % sessions.length)
    } else if (name === "return") {
      const session = sessions[selectedSession()]
      if (session !== undefined) {
        navigate({ type: "session", sessionId: session.id })
      }
    }
  })

  useBindings(() => ({
    enabled: !modalActive(),
    bindings: [
      {
        key: "<leader>m",
        desc: "Open model selector",
        group: "Home",
        cmd: () => modal.open(() => <DialogModel visible={() => true} onClose={modal.close} />),
      },
      {
        key: "<leader>l",
        desc: "Open session list",
        group: "Home",
        cmd: () =>
          modal.open(() => <DialogSessionList visible={() => true} onClose={modal.close} />),
      },
      {
        key: "ctrl+p",
        desc: "Open session list",
        group: "Home",
        cmd: () =>
          modal.open(() => <DialogSessionList visible={() => true} onClose={modal.close} />),
      },
      {
        key: "tab",
        desc: "Cycle permission mode (default/plan/auto/acceptEdits/full)",
        group: "Home",
        cmd: () => {
          const current = permissionMode()
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
          setPermissionMode(next)
          toast.show({
            title: "Permission mode",
            message: next,
            variant: next === "auto" ? "success" : "info",
          })
        },
      },
    ],
  }))

  const maxWidth = createMemo(() => Math.min(dims().width - 4, 96))
  const compactHome = createMemo(() => dims().width < 64 || dims().height < 22)
  const showLogo = createMemo(() => dims().width >= 50)
  const cwdMax = createMemo(() => {
    const inner = maxWidth() - 4
    return Math.max(8, inner - (showLogo() ? 37 : 0))
  })
  const cwdDisplay = createMemo(() => truncatePathLeft(local.cwd(), cwdMax()))

  return (
    <box
      flexGrow={1}
      alignItems="center"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme().background}
    >
      <box flexGrow={1} minHeight={0} />
      <box maxWidth={maxWidth()} flexDirection="column" width="100%" flexGrow={1} gap={0}>
        <box
          border
          borderColor={theme().border}
          backgroundColor={theme().backgroundPanel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexDirection={compactHome() ? "column" : "row"} gap={2}>
            <Show when={showLogo()}>
              <box flexDirection="column" flexShrink={0}>
                <For each={LOGO_LINES}>{(line) => <text fg={theme().primary}>{line}</text>}</For>
                <text fg={theme().textDim}>{"small \u00b7 quick \u00b7 curious"}</text>
              </box>
            </Show>
            <box flexDirection="column" flexGrow={1} minWidth={0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme().textMuted}>{"\u25ce"}</text>
                <text fg={theme().text} wrapMode="none">
                  {cwdDisplay()}
                </text>
              </box>
            </box>
          </box>
        </box>

        <box height={1} minHeight={0} flexShrink={1} />

        {/* Prompt */}
        <box width="100%" maxWidth={maxWidth()}>
          <Show when={autocompleteVisible()}>
            <PromptAutocomplete
              options={autocompleteOptions()}
              selectedIndex={autocompleteIndex()}
              onSelect={(idx) => {
                setAutocompleteIndex(idx)
                const selected = autocompleteOptions()[idx]
                if (selected !== undefined) {
                  textareaRef?.setText(selected.value)
                  setText(selected.value)
                  setAutocompleteVisible(false)
                  setAutocompleteIndex(0)
                  void submitPrompt(selected.value)
                }
              }}
            />
          </Show>
          <PromptShell
            model={local.model()}
            variant={effort()}
            permissionMode={permissionMode()}
            pasteSummary={undefined}
            status={{ type: "idle" }}
            interruptCount={0}
          >
            <textarea
              ref={(r: TextareaRenderable) => {
                textareaRef = r
              }}
              placeholder="Issue a local coding command..."
              onContentChange={onContentChange}
              onSubmit={() => {
                const input = textareaRef?.plainText ?? text()
                if (!autocompleteVisible() || isExactSlashCommand(input)) void submitPrompt(input)
              }}
              onKeyDown={onKeyDown}
              keyBindings={promptTextareaKeyBindings}
              focused={!modalActive()}
              flexGrow={1}
              minHeight={3}
              backgroundColor={theme().backgroundPanel}
              textColor={theme().text}
            />
          </PromptShell>
        </box>

        <Show
          when={recentSessions().length > 0}
          fallback={
            <box
              flexDirection="row"
              gap={1}
              border={["left"]}
              borderColor={theme().border}
              paddingLeft={1}
            >
              <text fg={theme().textMuted}>{"\u25b8"}</text>
              <text fg={theme().textDim}>No sessions yet — type below to start</text>
            </box>
          }
        >
          <box height={1} minHeight={0} flexShrink={1} />
          <box
            flexDirection="column"
            width="100%"
            border={["left"]}
            borderColor={theme().border}
            paddingLeft={1}
          >
            <text fg={theme().primary}>RECENT RUNS</text>
            <For each={recentSessions()}>
              {(session, idx) => {
                const preview = () => store.store.previews[session.id]
                const isSel = () => text().length === 0 && idx() === selectedSession()
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    backgroundColor={isSel() ? theme().selectionBg : undefined}
                  >
                    <text fg={isSel() ? theme().accent : theme().textMuted} flexShrink={0}>
                      {isSel() ? "\u25b8" : " "}
                    </text>
                    <text
                      fg={isSel() ? theme().text : theme().textMuted}
                      width={10}
                      flexShrink={0}
                      wrapMode="none"
                    >
                      {formatTime(preview()?.createdAt ?? "")}
                    </text>
                    <text
                      fg={isSel() ? theme().text : theme().textMuted}
                      width={15}
                      flexShrink={0}
                      wrapMode="none"
                    >
                      {truncateModel(session.modelId, 15)}
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={isSel() ? theme().text : theme().textDim} wrapMode="word">
                        {preview()?.text ?? ""}
                      </text>
                    </box>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </box>
      <box flexGrow={1} minHeight={0} />
    </box>
  )
}

import type { KeyEvent, MouseEvent, PasteEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { loadModelRegistry, loadWrenConfig } from "@wren/config-node"
import { isModelCommand, parseModelCommand } from "@wren/protocol"
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js"
import { useDialog } from "../context/dialog"
import { useLocal } from "../context/local"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useToast } from "../ui/toast"
import { VERSION } from "../version"
import {
  filterSlashCommands,
  isExactSlashCommand,
  PromptAutocomplete,
  shouldShowAutocomplete,
} from "./prompt-autocomplete"
import { createPromptHistory, type PromptHistory } from "./prompt-history"
import { promptTextareaKeyBindings } from "./prompt-keybindings"
import { createPasteHandler } from "./prompt-paste"
import { PromptShell } from "./prompt-shell"

const ABORT_TIMEOUT_MS = 5000

export function Prompt(props: {
  sessionId: string
  onOpenModelDialog?: () => void
  onOpenSessionList?: () => void
  onOpenVariants?: () => void
  onOpenHelp?: () => void
  onOpenTheme?: () => void
  onOpenDoctor?: () => void
  onOpenAgents?: () => void
  onOpenSkills?: () => void
  onExternalEditor?: (currentText: string) => Promise<void>
  onSubmit?: () => void
  editText?: string
  editMessageId?: string
  onEditTextConsumed?: () => void
  inputDisabled?: boolean
  onAutocompleteVisible?: (visible: boolean) => void
  history?: PromptHistory
}): JSX.Element {
  const adapter = useAdapter()
  const store = useStore()
  const { theme } = useTheme()
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()
  const history = props.history ?? createPromptHistory()

  const [input, setInput] = createSignal("")
  const [autocompleteVisible, setAutocompleteVisible] = createSignal(false)
  const [autocompleteIndex, setAutocompleteIndex] = createSignal(0)
  const [interruptCount, setInterruptCount] = createSignal(0)
  const [pasteSummary, setPasteSummary] = createSignal<string | undefined>()
  const [configuredEffort, setConfiguredEffort] = createSignal<string | undefined>()
  const [pendingEditMessageId, setPendingEditMessageId] = createSignal<string | undefined>()
  let textareaRef: TextareaRenderable | undefined
  let interruptTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (interruptTimer !== undefined) clearTimeout(interruptTimer)
  })

  createEffect(() => {
    const et = props.editText
    if (et !== undefined && et.length > 0) {
      textareaRef?.setText(et)
      textareaRef?.gotoBufferEnd()
      setInput(et)
      setPendingEditMessageId(props.editMessageId)
      props.onEditTextConsumed?.()
    }
  })

  const status = createMemo(() => store.store.status[props.sessionId] ?? { type: "idle" as const })
  const isWorking = createMemo(() => status().type !== "idle")
  const session = createMemo(() => store.store.sessions.find((item) => item.id === props.sessionId))
  const effectiveEffort = createMemo(() => session()?.effort ?? configuredEffort() ?? "default")
  const editReplacement = createMemo(() => pendingEditMessageId() !== undefined)

  const registry = createMemo(() => loadModelRegistry(local.cwd()))

  const cwdName = (): string => {
    const cwd = local.cwd()
    const home = process.env.HOME
    if (home && (cwd === home || cwd.startsWith(home + "/"))) {
      return "~" + cwd.slice(home.length)
    }
    return cwd
  }

  const modelContextLimit = (): number => {
    const modelId = session()?.modelId ?? local.model()
    const entries = registry().entries
    const exact = entries.find((e) => e.ref.modelId === modelId)
    if (exact?.contextLimit !== undefined) return exact.contextLimit
    const slashIdx = modelId.indexOf("/")
    if (slashIdx > 0) {
      const sourceName = modelId.slice(0, slashIdx)
      const bare = modelId.slice(slashIdx + 1)
      const bySource = entries.find((e) => e.sourceName === sourceName && e.ref.modelId === bare)
      if (bySource?.contextLimit !== undefined) return bySource.contextLimit
      const byBare = entries.find((e) => e.ref.modelId === bare)
      if (byBare?.contextLimit !== undefined) return byBare.contextLimit
    }
    return 128000
  }

  const tokenText = (): string => {
    const s = status()
    if (s.type === "working") {
      const total =
        s.usage.inputTokens +
        s.usage.outputTokens +
        s.usage.cacheReadTokens +
        s.usage.cacheCreationTokens
      if (total === 0) return ""
      if (total < 1000) return `${total} tok`
      return `${(total / 1000).toFixed(1)}k tok`
    }
    if (s.type === "idle" && s.lastUsage) {
      const total =
        s.lastUsage.inputTokens +
        s.lastUsage.outputTokens +
        s.lastUsage.cacheReadTokens +
        s.lastUsage.cacheCreationTokens
      if (total === 0) return ""
      if (total < 1000) return `${total} tok`
      return `${(total / 1000).toFixed(1)}k tok`
    }
    return ""
  }

  const contextPercent = (): string => {
    const s = status()
    const limit = modelContextLimit()
    if (s.type === "working") {
      const used = s.usage.inputTokens + s.usage.cacheReadTokens + s.usage.cacheCreationTokens
      if (used === 0) return ""
      const pct = Math.min(100, Math.round((used / limit) * 100))
      return `${pct}%`
    }
    if (s.type === "idle" && s.lastUsage) {
      const used =
        s.lastUsage.inputTokens + s.lastUsage.cacheReadTokens + s.lastUsage.cacheCreationTokens
      if (used === 0) return ""
      const pct = Math.min(100, Math.round((used / limit) * 100))
      return `${pct}%`
    }
    return ""
  }

  const contextColor = (): string => {
    const pct = contextPercent()
    if (pct === "") return theme().textMuted
    const num = parseInt(pct, 10)
    if (Number.isNaN(num)) return theme().textMuted
    if (num > 95) return theme().error
    if (num >= 80) return theme().warning
    return theme().textMuted
  }

  createEffect(() => {
    const modelId = session()?.modelId ?? local.model()
    void loadWrenConfig(undefined, local.cwd()).then((result) => {
      const configured = result.success
        ? Object.entries(result.config.sources).find(
            ([sourceName, source]) =>
              modelId.startsWith(`${sourceName}/`) &&
              source.models[modelId.slice(sourceName.length + 1)] !== undefined,
          )
        : undefined
      const [sourceName, source] = configured ?? []
      setConfiguredEffort(
        sourceName === undefined || source === undefined
          ? undefined
          : source.models[modelId.slice(sourceName.length + 1)]?.effort,
      )
    })
  })

  const autocompleteOptions = createMemo(() => {
    const text = input()
    if (!shouldShowAutocomplete(text)) return []
    return filterSlashCommands(text)
  })

  createEffect(() => {
    const text = input()
    const visible = shouldShowAutocomplete(text)
    setAutocompleteVisible(visible)
    if (visible) setAutocompleteIndex(0)
    props.onAutocompleteVisible?.(visible)
  })

  const handlePaste = createPasteHandler({
    getTextarea: () => textareaRef,
    setPasteSummary,
  })

  function cancelStagedEdit(): boolean {
    if (!editReplacement()) return false
    textareaRef?.clear()
    setInput("")
    setPendingEditMessageId(undefined)
    setAutocompleteVisible(false)
    return true
  }

  useKeyboard((key) => {
    if (props.inputDisabled) return
    if (key.name !== "escape") return
    if (!cancelStagedEdit()) return
    key.preventDefault()
    key.stopPropagation()
  })

  useBindings(() => ({
    enabled: !props.inputDisabled,
    bindings: [
      {
        key: "ctrl+l",
        desc: "Clear prompt",
        group: "Prompt",
        cmd: () => {
          textareaRef?.clear()
          setInput("")
          setPendingEditMessageId(undefined)
          setAutocompleteVisible(false)
          dialog.clear()
        },
      },
      {
        key: "escape",
        desc: "Cancel edit or interrupt",
        group: "Prompt",
        cmd: () => {
          if (cancelStagedEdit()) return
          if (autocompleteVisible()) {
            setAutocompleteVisible(false)
            return
          }
          handleEscape()
        },
      },
      {
        key: "<leader>e",
        desc: "External editor",
        group: "Prompt",
        cmd: () => {
          const currentText = textareaRef?.plainText ?? input()
          void props.onExternalEditor?.(currentText)
        },
      },
    ],
  }))

  function selectAutocomplete(): void {
    const options = autocompleteOptions()
    const selected = options[autocompleteIndex()]
    if (selected === undefined) return
    textareaRef?.setText(selected.value)
    textareaRef?.gotoBufferEnd()
    setInput(selected.value)
    setAutocompleteVisible(false)
    setAutocompleteIndex(0)
  }

  function navigateAutocomplete(direction: 1 | -1): void {
    const options = autocompleteOptions()
    if (options.length === 0) return
    setAutocompleteIndex((prev) => {
      const next = prev + direction
      if (next < 0) return options.length - 1
      if (next >= options.length) return 0
      return next
    })
  }

  function handleEscape(): void {
    if (autocompleteVisible()) {
      setAutocompleteVisible(false)
      return
    }
    if (!isWorking()) {
      return
    }
    const count = interruptCount() + 1
    setInterruptCount(count)
    if (count >= 2) {
      setInterruptCount(0)
      if (interruptTimer !== undefined) {
        clearTimeout(interruptTimer)
        interruptTimer = undefined
      }
      void adapter.fetch(
        createWrenRequest(`/session/${props.sessionId}/abort`, {
          method: "POST",
        }),
      )
    } else {
      if (interruptTimer !== undefined) clearTimeout(interruptTimer)
      interruptTimer = setTimeout(() => {
        interruptTimer = undefined
        setInterruptCount((c) => (c >= count ? 0 : c))
      }, ABORT_TIMEOUT_MS)
    }
  }

  function onKeyDown(event: KeyEvent): void {
    if (props.inputDisabled) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const key = event.name.toLowerCase()

    if (key === "escape" && cancelStagedEdit()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (autocompleteVisible()) {
      if (key === "up") {
        event.preventDefault()
        navigateAutocomplete(-1)
        return
      }
      if (key === "down") {
        event.preventDefault()
        navigateAutocomplete(1)
        return
      }
      if (key === "tab" || key === "return" || key === "kpenter") {
        event.preventDefault()
        const text = textareaRef?.plainText ?? input()
        if ((key === "return" || key === "kpenter") && isExactSlashCommand(text)) {
          setAutocompleteVisible(false)
          void handleSubmit(true)
          return
        }
        selectAutocomplete()
        if (key === "return" || key === "kpenter") {
          void handleSubmit()
        }
        return
      }
      if (key === "escape") {
        event.preventDefault()
        setAutocompleteVisible(false)
        return
      }
    }

    if (key === "escape") {
      event.preventDefault()
      handleEscape()
      return
    }

    if (key === "up" && !input().includes("\n")) {
      event.preventDefault()
      const entry = history.move("up", input())
      if (entry !== undefined) {
        textareaRef?.setText(entry)
        textareaRef?.gotoBufferEnd()
        setInput(entry)
      }
      return
    }

    if (key === "down" && !input().includes("\n")) {
      event.preventDefault()
      const entry = history.move("down", input())
      if (entry !== undefined) {
        textareaRef?.setText(entry)
        textareaRef?.gotoBufferEnd()
        setInput(entry)
      }
    }
  }

  async function onPaste(event: PasteEvent): Promise<void> {
    if (props.inputDisabled) {
      event.preventDefault()
      return
    }
    await handlePaste(event)
  }

  function onMouseUp(event: MouseEvent): void {
    if (props.inputDisabled) return
    if (event.isDragging) return
    if (!textareaRef) return
    const localX = event.x - textareaRef.x
    const localY = event.y - textareaRef.y
    if (localX < 0 || localY < 0) return
    textareaRef.editorView.setLocalSelection(
      localX,
      localY,
      localX,
      localY,
      undefined,
      undefined,
      true,
      false,
    )
  }

  async function handleSubmit(allowAutocomplete = false): Promise<void> {
    if (autocompleteVisible() && !allowAutocomplete) return
    const text = input() || (textareaRef?.plainText ?? "")
    if (text.trim() === "") return
    if (props.inputDisabled && !text.trim().startsWith("/")) return
    const trimmed = text.trim()
    const editId = pendingEditMessageId()

    textareaRef?.clear()
    setInput("")
    setAutocompleteVisible(false)

    try {
      const handledCommand = await handleSlashCommand(trimmed)
      if (handledCommand) {
        void history.append(trimmed)
        setPendingEditMessageId(undefined)
        return
      }
      const fullPrompt = trimmed

      const response = await adapter.fetch(
        createWrenRequest(`/session/${props.sessionId}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            editId !== undefined
              ? { prompt: fullPrompt, editMessageId: editId }
              : { prompt: fullPrompt },
          ),
        }),
      )
      if (response.ok) {
        let queued = false
        try {
          const body = (await response.json()) as { queued?: boolean }
          queued = body.queued === true
        } catch {
          // ignore parse errors
        }
        void history.append(trimmed)
        setPendingEditMessageId(undefined)
        props.onSubmit?.()
        if (queued) {
          toast.show({
            title: "Queued",
            message: "Message will send after current turn",
            variant: "info",
          })
        }
      } else {
        const status =
          response.statusText === ""
            ? `${response.status}`
            : `${response.status} ${response.statusText}`
        let bodyMessage: string | undefined
        let bodyError: string | undefined
        let reported = false
        try {
          const body = (await response.json()) as {
            message?: string
            error?: string
            reported?: boolean
          }
          bodyMessage = body.message
          bodyError = body.error
          reported = body.reported === true
        } catch {
          bodyMessage = undefined
        }
        if (!reported) {
          toast.show({
            title: "Submit failed",
            message: bodyMessage !== undefined ? `${status}: ${bodyMessage}` : status,
            variant: "error",
          })
        }
        // Terminal edit errors where retrying with the same editMessageId
        // cannot succeed. Exit replace mode and restore normal input so the
        // user can send the text as a fresh message instead.
        if (bodyError === "edit_anchor_stale" || bodyError === "edit_message_not_found") {
          setPendingEditMessageId(undefined)
          toast.show({
            title: "Edit unavailable",
            message:
              bodyError === "edit_anchor_stale"
                ? "This message can no longer be edited (history was compacted). Send as new message instead."
                : "The original message could not be found. Send as new message instead.",
            variant: "info",
          })
        } else if (bodyError === "session_busy") {
          // The previous turn's finalization started a queued prompt or
          // goal continuation. Clear the edit anchor so the next Enter
          // sends a plain message instead of retrying the stale edit.
          setPendingEditMessageId(undefined)
          textareaRef?.setText(trimmed)
          setInput(trimmed)
          toast.show({
            title: "Edit cancelled",
            message: "A new turn started while waiting. Send again as a new message.",
            variant: "info",
          })
        } else {
          // For other edit failures (network errors, 500s, etc.), keep the
          // edit text and editMessageId so the user can adjust and retry.
          textareaRef?.setText(trimmed)
          setInput(trimmed)
          if (editId !== undefined) setPendingEditMessageId(editId)
        }
      }
    } catch (error) {
      toast.show({
        title: "Submit failed",
        message: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      })
      textareaRef?.setText(trimmed)
      setInput(trimmed)
      if (editId !== undefined) setPendingEditMessageId(editId)
    }
  }

  async function handleSlashCommand(trimmed: string): Promise<boolean> {
    if (isModelCommand(trimmed)) {
      let cmd: ReturnType<typeof parseModelCommand>
      try {
        cmd = parseModelCommand(trimmed)
      } catch (error) {
        toast.show({
          title: "Invalid model command",
          message: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        })
        return true
      }
      if (cmd.verb === "open") {
        props.onOpenModelDialog?.()
        return true
      }
      if (cmd.verb === "set") {
        const modelId = `${cmd.ref.providerId}/${cmd.ref.modelId}`
        if (cmd.scope === "workspace") {
          toast.show({
            title: "Scope not supported",
            message: "--project scope is not supported; use --session or --user",
            variant: "error",
          })
          return true
        }
        const userScope = cmd.scope === "user"
        try {
          const response = await adapter.fetch(
            createWrenRequest(
              userScope ? `/config/default-model` : `/session/${props.sessionId}/model`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(userScope ? { modelId, scope: "user" } : { modelId }),
              },
            ),
          )
          if (!response.ok) {
            const status =
              response.statusText === ""
                ? `${response.status}`
                : `${response.status} ${response.statusText}`
            toast.show({
              title: "Model change failed",
              message: `${modelId}: ${status}`,
              variant: "error",
            })
            return true
          }
          const result = (await response.json()) as { ok: boolean; appliesTo?: string }
          if (result.appliesTo === "next_turn") {
            toast.show({
              title: "Model queued",
              message: `${modelId} applies next turn (current prompt running)`,
              variant: "info",
            })
          } else {
            toast.show({
              title: "Model set",
              message: `${modelId} (${userScope ? "user" : "session"})`,
              variant: "info",
            })
          }
        } catch (error) {
          toast.show({
            title: "Model change failed",
            message: error instanceof Error ? `${modelId}: ${error.message}` : modelId,
            variant: "error",
          })
          return true
        }
        local.setModel(modelId)
        return true
      }
      if (cmd.verb === "status") {
        const sessionModel = session()?.modelId ?? local.model()
        const effort = session()?.modelRef?.effort ?? effectiveEffort()
        toast.show({
          title: "Model status",
          message: `Session: ${sessionModel}\nEffort: ${effort}`,
          variant: "info",
        })
        return true
      }
      if (cmd.verb === "list") {
        toast.show({
          title: "Model list",
          message: "Use /models to open the picker",
          variant: "info",
        })
        return true
      }
      if (cmd.verb === "test") {
        const modelId = `${cmd.ref.providerId}/${cmd.ref.modelId}`
        try {
          const response = await adapter.fetch(
            createWrenRequest(`/session/${props.sessionId}/model/test`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ modelId }),
            }),
          )
          if (!response.ok) {
            toast.show({ title: "Model test failed", message: modelId, variant: "error" })
          } else {
            const result = (await response.json()) as {
              ok: boolean
              effectiveModelId?: string
              diagnostics?: { probe?: string; message?: string }
            }
            toast.show({
              title: "Model test",
              message: `${modelId}: ${result.diagnostics?.message ?? "accepted"}`,
              variant: "info",
            })
          }
        } catch {
          toast.show({ title: "Model test failed", message: modelId, variant: "error" })
        }
        return true
      }
      if (cmd.verb === "manage") {
        toast.show({
          title: "Model management",
          message: "Use /models to browse or /models set <id> to switch",
          variant: "info",
        })
        return true
      }
      return true
    }
    const command = trimmed.split(/\s+/)[0] ?? ""
    if (command === "/sessions") {
      props.onOpenSessionList?.()
      return true
    }
    if (command === "/mode") {
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
          body: JSON.stringify({ permissionMode: next }),
        }),
      )
      toast.show({
        title: "Permission mode",
        message: next === "auto" ? "classifier auto mode" : next,
        variant: next === "auto" ? "success" : "info",
      })
      return true
    }
    if (command === "/clear") {
      void adapter.fetch(createWrenRequest(`/session/${props.sessionId}/clear`, { method: "POST" }))
      textareaRef?.clear()
      setInput("")
      setPendingEditMessageId(undefined)
      setAutocompleteVisible(false)
      history.reset()
      dialog.clear()
      toast.show({ title: "Conversation cleared", message: "History reset", variant: "info" })
      return true
    }
    if (command === "/help") {
      props.onOpenHelp?.()
      return true
    }
    if (command === "/exit") {
      process.exit(0)
      return true
    }
    if (command === "/abort") {
      void adapter.fetch(createWrenRequest(`/session/${props.sessionId}/abort`, { method: "POST" }))
      toast.show({ title: "Abort", message: "Sending interrupt...", variant: "info" })
      return true
    }
    if (command === "/goal") {
      const trimmedGoal = trimmed.slice("/goal".length).trim()
      const lower = trimmedGoal.toLowerCase()
      const action =
        !trimmedGoal || lower === "status"
          ? "status"
          : lower === "clear"
            ? "clear"
            : lower === "pause"
              ? "pause"
              : lower === "resume"
                ? "resume"
                : lower === "complete"
                  ? "complete"
                  : lower === "continue"
                    ? "continue"
                    : "set"
      const payload = action === "set" ? { action, objective: trimmedGoal } : { action }
      try {
        const res = await adapter.fetch(
          createWrenRequest(`/session/${props.sessionId}/goal`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
        const data = (await res.json()) as {
          goal?: {
            objective: string
            status: string
            tokensUsed: number
            tokenBudget: number | null
            turnsExecuted: number
            maxTurns: number
          } | null
          ok?: boolean
          cleared?: boolean
          paused?: boolean
          resumed?: boolean
          completed?: boolean
          continued?: boolean
          objective?: string
          error?: string
        }
        if (!res.ok) {
          toast.show({
            title: "Goal",
            message: data.error ?? `Request failed: ${res.status}`,
            variant: "error",
          })
        } else if (action === "status") {
          const goal = data.goal
          if (goal === null || goal === undefined) {
            toast.show({
              title: "Goal",
              message: "No active goal. Set one with /goal <objective>",
              variant: "info",
            })
          } else {
            const tokens =
              goal.tokenBudget !== null
                ? `${goal.tokensUsed} / ${goal.tokenBudget}`
                : `${goal.tokensUsed}`
            toast.show({
              title: "Goal",
              message: `${goal.objective.slice(0, 80)}\nStatus: ${goal.status} | Turns: ${goal.turnsExecuted}/${goal.maxTurns} | Tokens: ${tokens}`,
              variant: "info",
            })
          }
        } else if (action === "set") {
          toast.show({
            title: "Goal set",
            message: (data.objective ?? trimmedGoal).slice(0, 80),
            variant: "success",
          })
        } else if (action === "clear") {
          toast.show({
            title: "Goal",
            message: data.cleared ? "Goal cleared" : "No active goal",
            variant: data.cleared ? "info" : "warning",
          })
        } else if (action === "pause") {
          toast.show({
            title: "Goal",
            message: data.paused ? "Goal paused" : "No active goal to pause",
            variant: data.paused ? "info" : "warning",
          })
        } else if (action === "resume") {
          toast.show({
            title: "Goal",
            message: data.resumed ? "Goal resumed" : "No paused goal to resume",
            variant: data.resumed ? "info" : "warning",
          })
        } else if (action === "complete") {
          toast.show({
            title: "Goal",
            message: data.completed ? "Goal marked complete" : "No active goal",
            variant: data.completed ? "success" : "warning",
          })
        } else if (action === "continue") {
          toast.show({
            title: "Goal",
            message: data.continued ? "Continuing..." : "Goal not in max-turns state",
            variant: data.continued ? "info" : "warning",
          })
        }
      } catch (err) {
        toast.show({
          title: "Goal",
          message: err instanceof Error ? err.message : "Request failed",
          variant: "error",
        })
      }
      return true
    }
    if (command === "/agents") {
      props.onOpenAgents?.()
      return true
    }
    if (command === "/theme") {
      props.onOpenTheme?.()
      return true
    }
    if (command === "/doctor") {
      props.onOpenDoctor?.()
      return true
    }
    if (command === "/skills") {
      props.onOpenSkills?.()
      return true
    }
    if (command === "/export") {
      try {
        const response = await adapter.fetch(
          createWrenRequest(`/session/${props.sessionId}/export`, { method: "GET" }),
        )
        if (response.ok) {
          const text = await response.text()
          const { writeFile } = await import("node:fs/promises")
          const { join } = await import("node:path")
          const filename = `wren-session-${props.sessionId.slice(0, 8)}.md`
          const filepath = join(process.cwd(), filename)
          await writeFile(filepath, text, "utf-8")
          toast.show({ title: "Session exported", message: filepath, variant: "success" })
        } else {
          toast.show({ title: "Export failed", message: `${response.status}`, variant: "error" })
        }
      } catch {
        toast.show({ title: "Export failed", message: "Network error", variant: "error" })
      }
      return true
    }
    if (command === "/version") {
      toast.show({ title: "Wren", message: `v${VERSION}`, variant: "info" })
      return true
    }
    if (command === "/variants") {
      props.onOpenVariants?.()
      return true
    }
    if (command.startsWith("/variants ")) {
      const arg = trimmed.slice("/variants ".length).trim().toLowerCase()
      const levels = ["low", "medium", "high", "xhigh", "max"]
      if (levels.includes(arg)) {
        try {
          const response = await adapter.fetch(
            createWrenRequest(`/session/${props.sessionId}/effort`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ effort: arg }),
            }),
          )
          if (!response.ok) {
            const status =
              response.statusText === ""
                ? `${response.status}`
                : `${response.status} ${response.statusText}`
            toast.show({
              title: "Thinking effort",
              message: `Change failed: ${status}`,
              variant: "error",
            })
            return true
          }
          local.setVariant(arg)
          toast.show({ title: "Thinking effort", message: arg, variant: "success" })
        } catch (error) {
          toast.show({
            title: "Thinking effort",
            message: error instanceof Error ? `Change failed: ${error.message}` : "Change failed",
            variant: "error",
          })
        }
      } else {
        toast.show({
          title: "Invalid effort",
          message: `Choose: ${levels.join(", ")}`,
          variant: "error",
        })
      }
      return true
    }
    return false
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={autocompleteVisible()}>
        <PromptAutocomplete
          options={autocompleteOptions()}
          selectedIndex={autocompleteIndex()}
          onSelect={(idx) => {
            setAutocompleteIndex(idx)
            const selected = autocompleteOptions()[idx]
            if (selected !== undefined) {
              textareaRef?.setText(selected.value)
              textareaRef?.gotoBufferEnd()
              setInput(selected.value)
              setAutocompleteVisible(false)
              setAutocompleteIndex(0)
              void handleSubmit()
            }
          }}
        />
      </Show>
      <PromptShell
        cwd={cwdName()}
        model={session()?.modelId ?? local.model()}
        variant={effectiveEffort()}
        permissionMode={session()?.permissionMode ?? "default"}
        pasteSummary={pasteSummary()}
        status={status()}
        interruptCount={interruptCount()}
        tokenText={tokenText()}
        contextPercent={contextPercent()}
        contextColor={contextColor()}
        hasContent={input().length > 0}
        showHints={!props.inputDisabled}
        editReplacement={editReplacement()}
      >
        <textarea
          ref={(r: TextareaRenderable) => {
            textareaRef = r
          }}
          placeholder={
            props.inputDisabled
              ? ""
              : "Ask Wren anything... (Enter to send, Shift+Enter for newline)"
          }
          onContentChange={() => {
            if (textareaRef) {
              setInput(textareaRef.plainText)
            }
          }}
          onSubmit={() => {
            const text = textareaRef?.plainText ?? input()
            void handleSubmit(isExactSlashCommand(text))
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onMouseUp={onMouseUp}
          keyBindings={promptTextareaKeyBindings}
          focused={!props.inputDisabled}
          minHeight={3}
          backgroundColor={theme().backgroundPanel}
          textColor={theme().text}
          placeholderColor={theme().textMuted}
          focusedBackgroundColor={theme().backgroundPanel}
          focusedTextColor={theme().text}
        />
      </PromptShell>
    </box>
  )
}

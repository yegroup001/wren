/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { loadModelRegistry } from "@wren/config-node"
import type { ModelCatalogEntry } from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useAdapter } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { useToast } from "../ui/toast"
import { fuzzyMatch } from "./fuzzy"

type DisplayEntry = {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly providerLabel: string
  readonly contextLimit: number
  readonly defaultEffort?: string
}

type ModelScope = "session" | "user"

function toDisplayEntry(entry: ModelCatalogEntry): DisplayEntry {
  const sourceName = entry.sourceName
  const label =
    sourceName ?? entry.providerName ?? entry.baseUrl ?? providerTypeLabel(entry.ref.providerId)
  return {
    id: sourceName === undefined ? entry.ref.modelId : `${sourceName}/${entry.ref.modelId}`,
    name: entry.ref.displayName ?? entry.ref.modelId,
    provider: entry.ref.providerId,
    providerLabel: label,
    contextLimit: entry.contextLimit ?? 0,
    defaultEffort: entry.defaultEffort,
  }
}

function providerTypeLabel(provider: string): string {
  if (provider === "openai-compatible" || provider === "openai-compatible-chat")
    return "OpenAI-compatible"
  if (provider === "") return ""
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

function formatContextLimit(limit: number): string {
  if (limit <= 0) return "?"
  return `${(limit / 1000).toFixed(0)}k`
}

function scopeTitle(s: ModelScope): string {
  return s === "session" ? "Session" : "User"
}

export function DialogModel(props: {
  sessionId?: string
  visible: () => boolean
  onClose: () => void
}): JSX.Element {
  const { theme } = useTheme()
  const adapter = useAdapter()
  const local = useLocal()
  const dims = useTerminalDimensions()
  const toast = useToast()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [errorMessage, setErrorMessage] = createSignal<string | undefined>()
  const [applying, setApplying] = createSignal(false)

  let justOpened = false

  // Reset transient state whenever the dialog opens.
  createEffect(() => {
    if (props.visible()) {
      setFilter("")
      setSelected(0)
      setErrorMessage(undefined)
      setScope(props.sessionId !== undefined ? "session" : "user")
      justOpened = true
      queueMicrotask(() => {
        justOpened = false
      })
    }
  })

  createEffect(() => {
    if (!props.visible()) {
      setApplying(false)
      setErrorMessage(undefined)
    }
  })

  const allOptions = createMemo<readonly DisplayEntry[]>(() =>
    loadModelRegistry(local.cwd()).entries.map(toDisplayEntry),
  )

  const filtered = createMemo<readonly DisplayEntry[]>(() => {
    const needle = filter().toLowerCase()
    if (needle === "") return [...allOptions()]
    return allOptions().filter(
      (opt) =>
        fuzzyMatch(needle, opt.name) ||
        fuzzyMatch(needle, opt.provider) ||
        fuzzyMatch(needle, opt.providerLabel) ||
        fuzzyMatch(needle, opt.id),
    )
  })

  const hasCustomEntry = createMemo(() => filter().length > 0 && filtered().length === 0)

  const totalItems = createMemo(() => filtered().length + (hasCustomEntry() ? 1 : 0))

  const currentEntry = createMemo<DisplayEntry | undefined>(() => {
    const list = filtered()
    if (list.length === 0) return undefined
    const idx = Math.min(selected(), list.length - 1)
    return list[idx]
  })

  const [scope, setScope] = createSignal<ModelScope>(
    props.sessionId !== undefined ? "session" : "user",
  )
  const scopeOrder: readonly ModelScope[] =
    props.sessionId !== undefined ? ["session", "user"] : ["user"]

  function cycleScope(direction: 1 | -1): void {
    const idx = scopeOrder.indexOf(scope())
    const nextIdx = (idx + direction + scopeOrder.length) % scopeOrder.length
    const next = scopeOrder[nextIdx]
    if (next !== undefined) setScope(next)
  }

  useOverlay({
    visible: props.visible,
    onClose: () => {
      if (applying()) {
        toast.show({ message: "Applying model...", variant: "info" })
        return
      }
      props.onClose()
    },
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "up" || (key.ctrl && name === "p")) {
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      if (name === "down" || (key.ctrl && name === "n")) {
        setSelected((s) => Math.min(Math.max(0, totalItems() - 1), s + 1))
        return
      }
      if (name === "left") {
        if (!applying()) cycleScope(-1)
        return
      }
      if (name === "right") {
        if (!applying()) cycleScope(1)
        return
      }
      if (name === "return" || name === "kpenter") {
        // Ignore the Enter that opened the dialog (race with textarea onSubmit)
        if (justOpened) {
          justOpened = false
          return
        }
        if (applying()) return
        const opt = currentEntry()
        if (opt) {
          void chooseModel(opt)
        } else if (hasCustomEntry()) {
          void chooseModel({
            id: filter(),
            name: filter(),
            provider: "openai-compatible",
            providerLabel: "OpenAI-compatible",
            contextLimit: 0,
          })
        }
        return
      }
      if (name === "backspace") {
        setFilter((f) => f.slice(0, -1))
        setSelected(0)
        return
      }
      if (name === "space" && !key.ctrl && !key.meta) {
        setFilter((f) => `${f} `)
        setSelected(0)
        return
      }
      if (name.length === 1 && !key.ctrl && !key.meta) {
        const char = key.shift ? name.toUpperCase() : name
        setFilter((f) => f + char)
        setSelected(0)
        return
      }
    },
  })

  const dialogWidth = createMemo(() => Math.min(72, dims().width - 4))

  async function chooseModel(opt: DisplayEntry): Promise<void> {
    setErrorMessage(undefined)
    if (applying()) return
    const currentScope = scope()
    setApplying(true)
    try {
      let response: Response
      if (currentScope === "session" && props.sessionId !== undefined) {
        response = await adapter.fetch(
          createWrenRequest(`/session/${props.sessionId}/model`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId: opt.id }),
          }),
        )
      } else {
        response = await adapter.fetch(
          createWrenRequest("/config/default-model", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId: opt.id, scope: "user" }),
          }),
        )
      }
      if (!response.ok) {
        const status =
          response.statusText === ""
            ? `${response.status}`
            : `${response.status} ${response.statusText}`
        setErrorMessage(`Model change failed for ${opt.id}: ${status}`)
        return
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setErrorMessage(`Model change failed for ${opt.id}: ${msg}`)
      return
    } finally {
      setApplying(false)
    }
    local.setModel(opt.id)
    props.onClose()
  }

  return (
    <Show when={props.visible()}>
      <box
        flexGrow={1}
        alignItems="center"
        paddingTop={Math.floor(dims().height / 6)}
        backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      >
        <box
          width={dialogWidth()}
          backgroundColor={theme().backgroundPanel}
          border
          borderColor={theme().border}
          paddingTop={1}
          paddingBottom={1}
        >
          <box paddingLeft={2} paddingRight={2} flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme().text}>
              Select model
            </text>
            <box flexDirection="row" gap={1}>
              <For each={scopeOrder}>
                {(s) => (
                  <text
                    fg={scope() === s ? theme().accent : theme().textMuted}
                    attributes={scope() === s ? TextAttributes.BOLD : undefined}
                    onMouseUp={() => {
                      if (!applying()) setScope(s)
                    }}
                  >
                    [{scopeTitle(s)}]
                  </text>
                )}
              </For>
            </box>
          </box>
          <box paddingLeft={2} paddingRight={2}>
            <text fg={theme().textMuted}>Current: {local.model()}</text>
          </box>
          <Show when={filter() !== ""}>
            <box paddingLeft={2}>
              <text fg={theme().text}>
                Filter: {filter()}
                {"\u2588"}
              </text>
            </box>
          </Show>
          <Show when={errorMessage()}>
            {(message) => (
              <box paddingLeft={2} paddingRight={2}>
                <text fg={theme().error} wrapMode="word">
                  {message()}
                </text>
              </box>
            )}
          </Show>
          <Show when={applying()}>
            <box paddingLeft={2} paddingRight={2}>
              <text fg={theme().textMuted}>applying...</text>
            </box>
          </Show>
          <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
            <scrollbox maxHeight={15} verticalScrollbarOptions={{ visible: true }}>
              <For each={filtered()}>
                {(opt, idx) => {
                  const isSel = () => idx() === Math.min(selected(), totalItems() - 1)
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      backgroundColor={isSel() ? theme().selectionBg : undefined}
                      onMouseUp={() => {
                        if (applying()) return
                        void chooseModel(opt)
                      }}
                    >
                      <text fg={isSel() ? theme().accent : theme().textMuted}>
                        {isSel() ? "\u25b8" : " "}
                      </text>
                      <text
                        fg={theme().text}
                        attributes={isSel() ? TextAttributes.BOLD : undefined}
                        wrapMode="none"
                      >
                        {opt.name}
                      </text>
                      <text fg={theme().textMuted}>{opt.providerLabel}</text>
                      <Show when={opt.defaultEffort !== undefined}>
                        <text fg={theme().textMuted}>effort {opt.defaultEffort}</text>
                      </Show>
                      <box flexGrow={1} />
                      <text fg={theme().textMuted}>{formatContextLimit(opt.contextLimit)}</text>
                    </box>
                  )
                }}
              </For>
              <Show when={hasCustomEntry()}>
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  onMouseUp={() => {
                    if (applying()) return
                    void chooseModel({
                      id: filter(),
                      name: filter(),
                      provider: "openai-compatible",
                      providerLabel: "OpenAI-compatible",
                      contextLimit: 0,
                    })
                  }}
                >
                  <text fg={theme().accent}>{"\u25b8"}</text>
                  <text fg={theme().text} attributes={TextAttributes.BOLD}>
                    Use custom ID: "{filter()}"
                  </text>
                </box>
              </Show>
              <Show when={filtered().length === 0 && !hasCustomEntry()}>
                <box paddingLeft={1}>
                  <text fg={theme().textMuted}>No matches. Type to create a custom ID.</text>
                </box>
              </Show>
            </scrollbox>
          </box>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">
              {
                "enter select · type filter/custom · ←/→ scope · esc"
              }
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}

/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { loadModelRegistry } from "@wren/config-node"
import { EFFORT_LEVELS, type EffortLevel } from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useAdapter } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { useToast } from "../ui/toast"

export function DialogVariants(props: {
  sessionId?: string
  modelId?: () => string | undefined
  visible: () => boolean
  onClose: () => void
  effort?: () => string
  onSelect?: (effort: string) => void
}): JSX.Element {
  const adapter = useAdapter()
  const toast = useToast()
  const { theme } = useTheme()
  const local = useLocal()
  const dims = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)
  const dialogWidth = createMemo(() => Math.min(40, dims().width - 4))
  let justOpened = false

  const efforts = createMemo<readonly EffortLevel[]>(() => {
    const modelId = props.modelId?.()
    if (modelId === undefined) return EFFORT_LEVELS
    const registry = loadModelRegistry(local.cwd())
    const findEntry = () => {
      const exact = registry.entries.find((e) => e.ref.modelId === modelId)
      if (exact !== undefined) return exact
      const slashIdx = modelId.indexOf("/")
      if (slashIdx > 0) {
        const sourceName = modelId.slice(0, slashIdx)
        const bare = modelId.slice(slashIdx + 1)
        const bySource = registry.entries.find(
          (e) => e.sourceName === sourceName && e.ref.modelId === bare,
        )
        if (bySource !== undefined) return bySource
        const byBare = registry.entries.find((e) => e.ref.modelId === bare)
        if (byBare !== undefined) return byBare
      }
      return undefined
    }
    const entry = findEntry()
    // If the model has explicit effort levels, use them
    if (entry?.efforts !== undefined && entry.efforts.length > 0) return entry.efforts
    // If the model has a non-effort-levels mechanism, return empty (show unsupported)
    if (entry?.reasoningMechanism !== undefined && entry.reasoningMechanism !== "effort-levels")
      return []
    // Fallback: show all levels for models without explicit config (backward compat)
    return EFFORT_LEVELS
  })

  const isUnsupported = createMemo(() => efforts().length === 0)

  createEffect(() => {
    if (!props.visible()) return
    const current = props.effort?.() ?? local.variant()
    const list = efforts()
    const currentIndex = list.indexOf(current as EffortLevel)
    setSelected(currentIndex === -1 ? 0 : currentIndex)
    justOpened = true
    queueMicrotask(() => {
      justOpened = false
    })
  })

  async function choose(effort: EffortLevel): Promise<void> {
    if (props.sessionId === undefined) {
      props.onSelect?.(effort)
      props.onClose()
      return
    }
    try {
      const response = await adapter.fetch(
        createWrenRequest(`/session/${props.sessionId}/effort`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ effort }),
        }),
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const msg =
          body?.message ??
          (response.statusText === ""
            ? `${response.status}`
            : `${response.status} ${response.statusText}`)
        toast.show({ title: "Thinking effort", message: `Change failed: ${msg}`, variant: "error" })
        return
      }
      local.setVariant(effort)
      toast.show({ title: "Thinking effort", message: effort, variant: "success" })
      props.onClose()
    } catch (error) {
      toast.show({
        title: "Thinking effort",
        message: error instanceof Error ? `Change failed: ${error.message}` : "Change failed",
        variant: "error",
      })
    }
  }

  useOverlay({
    visible: props.visible,
    onClose: props.onClose,
    onKey: (key: KeyEvent) => {
      if (isUnsupported()) {
        if (key.name === "return" || key.name === "kpenter" || key.name === "escape") {
          props.onClose()
        }
        return
      }
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        setSelected((index) => Math.max(0, index - 1))
        return
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        setSelected((index) => Math.min(efforts().length - 1, index + 1))
        return
      }
      if (key.name === "return" || key.name === "kpenter") {
        if (justOpened) {
          justOpened = false
          return
        }
        const effort = efforts()[selected()]
        if (effort !== undefined) void choose(effort)
      }
    },
  })

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
          <box paddingLeft={2} paddingRight={2}>
            <text attributes={TextAttributes.BOLD} fg={theme().text}>
              Thinking effort
            </text>
          </box>
          <Show
            when={!isUnsupported()}
            fallback={
              <box paddingLeft={2} paddingRight={2} flexDirection="column" gap={1}>
                <text fg={theme().textMuted}>This model does not support effort levels.</text>
                <text fg={theme().textMuted}>
                  Thinking is controlled by the provider configuration.
                </text>
                <text fg={theme().textMuted} wrapMode="none">{"press enter or esc to close"}</text>
              </box>
            }
          >
            <box paddingLeft={2} paddingRight={2}>
              <text fg={theme().textMuted}>Current: {props.effort?.() ?? local.variant()}</text>
            </box>
            <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
              <For each={efforts()}>
                {(effort, index) => {
                  const isSelected = (): boolean => index() === selected()
                  const isCurrent = (): boolean => effort === (props.effort?.() ?? local.variant())
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      backgroundColor={isSelected() ? theme().selectionBg : undefined}
                      onMouseUp={() => void choose(effort)}
                    >
                      <text fg={isSelected() ? theme().accent : theme().textMuted}>
                        {isSelected() ? "▸" : " "}
                      </text>
                      <text
                        fg={theme().text}
                        attributes={isSelected() ? TextAttributes.BOLD : undefined}
                      >
                        {effort}
                      </text>
                      <Show when={isCurrent()}>
                        <text fg={theme().success}>{"(current)"}</text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </box>
            <box paddingLeft={2} marginTop={1}>
              <text fg={theme().textMuted} wrapMode="none">{"enter select · ↑/↓ navigate · esc cancel"}</text>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

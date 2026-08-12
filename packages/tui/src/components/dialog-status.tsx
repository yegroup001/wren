/** @jsxImportSource @opentui/solid */

import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { loadModelRegistry } from "@wren/config-node"
import { createMemo, type JSX, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"

export function DialogStatus(props: {
  sessionId: string
  visible: () => boolean
  onClose: () => void
}): JSX.Element {
  const store = useStore()
  const local = useLocal()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()

  useOverlay({
    visible: props.visible,
    onClose: props.onClose,
  })

  const status = createMemo(() => store.store.status[props.sessionId] ?? { type: "idle" as const })
  const session = createMemo(() => store.store.sessions.find((s) => s.id === props.sessionId))

  const modelId = createMemo(() => {
    const s = status()
    if (s.type === "working") return s.model
    return session()?.modelId ?? local.model()
  })

  const contextLimit = createMemo(() => {
    const registry = loadModelRegistry(local.cwd())
    const id = modelId()
    const exact = registry.entries.find((e) => e.ref.modelId === id)
    if (exact?.contextLimit !== undefined) return exact.contextLimit
    const slashIdx = id.indexOf("/")
    if (slashIdx > 0) {
      const sourceName = id.slice(0, slashIdx)
      const bare = id.slice(slashIdx + 1)
      const bySource = registry.entries.find(
        (e) => e.sourceName === sourceName && e.ref.modelId === bare,
      )
      if (bySource?.contextLimit !== undefined) return bySource.contextLimit
      const byBare = registry.entries.find((e) => e.ref.modelId === bare)
      if (byBare?.contextLimit !== undefined) return byBare.contextLimit
    }
    return 200000
  })

  const tokenInfo = createMemo(() => {
    const s = status()
    if (s.type === "working") {
      const total = s.usage.inputTokens + s.usage.outputTokens
      return {
        total,
        input: s.usage.inputTokens,
        output: s.usage.outputTokens,
        cost: s.costUsd,
        durationMs: s.usage.durationMs,
        numTurns: s.usage.numTurns,
        stopReason: s.usage.stopReason,
      }
    }
    if (s.type === "idle" && s.lastUsage) {
      const total = s.lastUsage.inputTokens + s.lastUsage.outputTokens
      return {
        total,
        input: s.lastUsage.inputTokens,
        output: s.lastUsage.outputTokens,
        cost: s.lastUsage.costUsd,
        durationMs: s.lastUsage.durationMs,
        numTurns: s.lastUsage.numTurns,
        stopReason: s.lastUsage.stopReason,
      }
    }
    return null
  })

  const dialogWidth = createMemo(() => Math.min(56, dims().width - 4))

  function row(label: string, value: string): JSX.Element {
    return (
      <box flexDirection="row" gap={1} paddingLeft={2}>
        <text fg={theme().textMuted} flexShrink={0} width={12}>
          {label}
        </text>
        <text fg={theme().text} wrapMode="word">
          {value}
        </text>
      </box>
    )
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
          gap={0}
        >
          <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
            <text attributes={TextAttributes.BOLD} fg={theme().text}>
              Status
            </text>
          </box>
          {row("Model", modelId() || "\u2014")}
          {row("CWD", local.cwd() || "\u2014")}
          {row("Session", props.sessionId)}
          <Show when={tokenInfo()}>
            {(t) => {
              const info = t()
              return (
                <box flexDirection="column" gap={0}>
                  {row("Tokens", `${info.total} / ${contextLimit()}`)}
                  {row("  Input", String(info.input))}
                  {row("  Output", String(info.output))}
                  {row("Cost", info.cost > 0 ? `$${info.cost.toFixed(4)}` : "\u2014")}
                  {row(
                    "Duration",
                    info.durationMs !== undefined
                      ? `${(info.durationMs / 1000).toFixed(1)}s`
                      : "\u2014",
                  )}
                  {row("Turns", info.numTurns !== undefined ? String(info.numTurns) : "\u2014")}
                  {row("Stop", info.stopReason ?? "\u2014")}
                </box>
              )
            }}
          </Show>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">esc to close</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

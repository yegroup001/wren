/** @jsxImportSource @opentui/solid */

import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useAdapter } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"

type Diagnostic = { level: "info" | "warning" | "error"; message: string }

export function DialogDoctor(props: { visible: () => boolean; onClose: () => void }): JSX.Element {
  const adapter = useAdapter()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const [diagnostics, setDiagnostics] = createSignal<Diagnostic[]>([])
  const [loading, setLoading] = createSignal(false)

  useOverlay({
    visible: props.visible,
    onClose: props.onClose,
  })

  createEffect(() => {
    if (!props.visible()) return
    setLoading(true)
    void (async () => {
      try {
        const res = await adapter.fetch(createWrenRequest("/config"))
        if (res.ok) {
          const config = (await res.json()) as { diagnostics?: Diagnostic[] }
          setDiagnostics(config.diagnostics ?? [])
        }
      } catch {
        setDiagnostics([])
      } finally {
        setLoading(false)
      }
    })()
  })

  const dialogWidth = createMemo(() => Math.min(64, dims().width - 4))

  function levelColor(level: string): string {
    if (level === "error") return theme().error
    if (level === "warning") return theme().warning
    return theme().info
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
          <box paddingLeft={2} paddingRight={2}>
            <text attributes={TextAttributes.BOLD} fg={theme().text}>
              Diagnostics
            </text>
          </box>
          <Show when={loading()}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>Loading...</text>
            </box>
          </Show>
          <Show when={!loading() && diagnostics().length === 0}>
            <box paddingLeft={2}>
              <text fg={theme().success}>No issues found</text>
            </box>
          </Show>
          <Show when={diagnostics().length > 0}>
            <scrollbox
              flexGrow={1}
              maxHeight={Math.floor(dims().height / 3)}
              verticalScrollbarOptions={{ visible: false }}
            >
              <For each={diagnostics()}>
                {(diag) => (
                  <box flexDirection="row" gap={1} paddingLeft={2}>
                    <text fg={levelColor(diag.level)} flexShrink={0}>
                      {diag.level === "error"
                        ? "\u2717"
                        : diag.level === "warning"
                          ? "\u25b3"
                          : "\u2139"}
                    </text>
                    <text fg={theme().text} wrapMode="word">
                      {diag.message}
                    </text>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">esc to close</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

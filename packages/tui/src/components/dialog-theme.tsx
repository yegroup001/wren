/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"

export function DialogTheme(props: { visible: () => boolean; onClose: () => void }): JSX.Element {
  const { theme, themes, selected, set: setTheme } = useTheme()
  const dims = useTerminalDimensions()
  const [idx, setIdx] = createSignal(0)

  createEffect(() => {
    if (props.visible()) {
      const currentIdx = themes.indexOf(selected())
      setIdx(currentIdx === -1 ? 0 : currentIdx)
    }
  })

  useOverlay({
    visible: props.visible,
    onClose: props.onClose,
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "up") {
        setIdx((i) => Math.max(0, i - 1))
        return
      }
      if (name === "down") {
        setIdx((i) => Math.min(themes.length - 1, i + 1))
        return
      }
      if (name === "return") {
        const themeName = themes[idx()]
        if (themeName !== undefined && setTheme(themeName)) {
          props.onClose()
        }
        return
      }
    },
  })

  const dialogWidth = createMemo(() => Math.min(48, dims().width - 4))

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
              Themes
            </text>
          </box>
          <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
            <For each={themes}>
              {(name, index) => {
                const isSel = () => index() === idx()
                const isCurrent = () => name === selected()
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    paddingLeft={1}
                    backgroundColor={isSel() ? theme().selectionBg : undefined}
                  >
                    <text fg={isSel() ? theme().accent : theme().textMuted}>
                      {isSel() ? "\u25b8" : " "}
                    </text>
                    <text
                      fg={
                        isCurrent() ? theme().success : isSel() ? theme().text : theme().textMuted
                      }
                      attributes={isSel() ? TextAttributes.BOLD : undefined}
                    >
                      {name}
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
            <text fg={theme().textMuted} wrapMode="none">{"enter apply · esc"}</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

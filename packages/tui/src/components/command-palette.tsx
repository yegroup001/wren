/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { fuzzyMatch } from "./fuzzy"

export type CommandAction = {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly keybinding: string
  readonly category: string
  readonly run: () => void
}

export type CommandPaletteProps = {
  readonly visible: () => boolean
  readonly onClose: () => void
  readonly actions: () => readonly CommandAction[]
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    if (needle === "") return props.actions()
    return props
      .actions()
      .filter((a) => fuzzyMatch(needle, a.title) || fuzzyMatch(needle, a.description))
  })

  useOverlay({
    visible: props.visible,
    onClose: () => {
      props.onClose()
      setFilter("")
      setSelected(0)
    },
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "up" || (key.ctrl && name === "p")) {
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      if (name === "down" || (key.ctrl && name === "n")) {
        setSelected((s) => Math.min(Math.max(0, filtered().length - 1), s + 1))
        return
      }
      if (name === "return") {
        const action = filtered()[selected()]
        if (action) {
          action.run()
          props.onClose()
          setFilter("")
          setSelected(0)
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

  const dialogWidth = createMemo(() => Math.min(64, dims().width - 4))

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
          borderColor={theme().accent}
          paddingTop={1}
          paddingBottom={1}
        >
          <box paddingLeft={2} paddingRight={2} flexDirection="row" gap={1}>
            <text fg={theme().accent}>:</text>
            <Show when={filter() === ""} fallback={<text fg={theme().text}>{filter()}</text>}>
              <text fg={theme().textMuted}>Type to search commands...</text>
            </Show>
          </box>
          <Show
            when={filtered().length > 0}
            fallback={
              <box paddingLeft={2} marginTop={1}>
                <text fg={theme().textMuted}>No matching commands</text>
              </box>
            }
          >
            <scrollbox
              flexGrow={1}
              maxHeight={Math.floor(dims().height / 3)}
              verticalScrollbarOptions={{ visible: false }}
            >
              <For each={filtered()}>
                {(action, idx) => {
                  const isSel = () => idx() === selected()
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={isSel() ? theme().selectionBg : undefined}
                    >
                      <text
                        fg={isSel() ? theme().accent : theme().textMuted}
                        flexShrink={0}
                        wrapMode="none"
                      >
                        {isSel() ? "\u25b8" : " "}
                      </text>
                      <text
                        fg={theme().textMuted}
                        flexShrink={0}
                        wrapMode="none"
                        children={action.category}
                      />
                      <text
                        fg={isSel() ? theme().accent : theme().text}
                        attributes={isSel() ? TextAttributes.BOLD : undefined}
                        flexGrow={1}
                        children={action.title}
                      />
                      <box flexGrow={1} />
                      <Show when={action.keybinding.length > 0}>
                        <text fg={theme().textMuted} flexShrink={0}>
                          {action.keybinding}
                        </text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">enter run · esc to cancel</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

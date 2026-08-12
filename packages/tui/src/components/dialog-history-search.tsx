/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"

type HistoryEntry = { input: string; timestamp: string }

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "  --  "
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  return `${m}/${d} ${h}:${min}`
}

export function DialogHistorySearch(props: {
  visible: () => boolean
  onClose: () => void
  entries: () => readonly HistoryEntry[]
  onSelect: (input: string) => void
}): JSX.Element {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)

  const reversed = createMemo(() => [...props.entries()].reverse())

  const filtered = createMemo(() => {
    const needle = query().toLowerCase()
    if (needle === "") return reversed()
    return reversed().filter((e) => e.input.toLowerCase().includes(needle))
  })

  createEffect(() => {
    filtered()
    setSelected(0)
  })

  useOverlay({
    visible: props.visible,
    onClose: () => {
      setQuery("")
      setSelected(0)
      props.onClose()
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
        const item = filtered()[selected()]
        if (item) {
          props.onSelect(item.input)
          props.onClose()
        }
        return
      }
      if (name === "backspace") {
        setQuery((q) => q.slice(0, -1))
        return
      }
      if (name === "space" && !key.ctrl && !key.meta) {
        setQuery((q) => `${q} `)
        return
      }
      if (name.length === 1 && !key.ctrl && !key.meta) {
        const char = key.shift ? name.toUpperCase() : name
        setQuery((q) => q + char)
        return
      }
    },
  })

  const dialogWidth = createMemo(() => Math.min(72, dims().width - 4))

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
              History Search
            </text>
          </box>
          <box paddingLeft={2} flexDirection="row" gap={1}>
            <text fg={theme().textMuted} wrapMode="none">
              query:
            </text>
            <text fg={theme().accent} wrapMode="none">
              {query()}
            </text>
            <text fg={theme().textMuted}>{"\u2588"}</text>
          </box>
          <Show
            when={filtered().length > 0}
            fallback={
              <box paddingLeft={2}>
                <text fg={theme().textMuted}>
                  {query() === "" ? "Start typing to search..." : "No matches"}
                </text>
              </box>
            }
          >
            <scrollbox
              flexGrow={1}
              maxHeight={Math.floor(dims().height / 3)}
              verticalScrollbarOptions={{ visible: false }}
            >
              <For each={filtered()}>
                {(entry, idx) => {
                  const isSel = () => idx() === selected()
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      backgroundColor={isSel() ? theme().selectionBg : undefined}
                    >
                      <text fg={isSel() ? theme().selectionFg : theme().textMuted} flexShrink={0}>
                        {isSel() ? "\u25b8" : " "}
                      </text>
                      <text
                        fg={isSel() ? theme().selectionFg : theme().textMuted}
                        flexShrink={0}
                        wrapMode="none"
                      >
                        {formatTime(entry.timestamp)}
                      </text>
                      <box flexGrow={1} minWidth={0}>
                        <text fg={isSel() ? theme().selectionFg : theme().text} wrapMode="none">
                          {entry.input}
                        </text>
                      </box>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">
              {"type search · ↑/↓ navigate · enter select · esc"}
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}

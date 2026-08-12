/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { fuzzyMatch } from "./fuzzy"

type HelpEntry = { readonly key: string; readonly desc: string; readonly group: string }

const HELP_ENTRIES: readonly HelpEntry[] = [
  { key: "Ctrl+C", desc: "Exit the application", group: "App" },
  { key: "Ctrl+P", desc: "Open command palette", group: "App" },
  { key: "Ctrl+R", desc: "Search prompt history", group: "Input" },
  { key: "<leader>h", desc: "Show this help dialog", group: "App" },
  { key: "<leader>n / Ctrl+N", desc: "Back to home (new session)", group: "Session" },
  { key: "<leader>l", desc: "List all sessions", group: "Session" },
  { key: "<leader>r", desc: "Rename current session", group: "Session" },
  { key: "<leader>s", desc: "Show session status", group: "Session" },
  { key: "<leader>e", desc: "Open external editor", group: "Input" },
  { key: "<leader>m", desc: "Open model selector", group: "Model" },
  { key: "\u2190 / \u2192", desc: "Cycle model scope (session/user)", group: "Model" },
  { key: "<leader>t", desc: "Open theme picker", group: "View" },
  { key: "<leader>d", desc: "Toggle diff panel", group: "View" },
  { key: "<leader>v", desc: "Toggle full diff viewer", group: "View" },
  { key: "<leader>g", desc: "Scroll to bottom", group: "Navigation" },
  { key: "Ctrl+B", desc: "Scroll up half page", group: "Navigation" },
  { key: "Ctrl+D", desc: "Scroll down half page", group: "Navigation" },
  { key: "Ctrl+G / Home", desc: "Scroll to top", group: "Navigation" },
  { key: "End", desc: "Scroll to bottom", group: "Navigation" },
  { key: "PageUp", desc: "Page up", group: "Navigation" },
  { key: "PageDown", desc: "Page down", group: "Navigation" },
  { key: "<leader>p", desc: "Cycle permission mode", group: "Permissions" },
  { key: "Tab", desc: "Cycle permission mode (home; includes full)", group: "Permissions" },
  { key: "Enter", desc: "Submit prompt", group: "Input" },
  { key: "Shift+Enter", desc: "Insert newline", group: "Input" },
  { key: "Up / Down", desc: "Navigate prompt history", group: "Input" },
  { key: "Escape", desc: "Interrupt / close dialog", group: "Input" },
]

export function DialogHelp(props: { visible: () => boolean; onClose: () => void }): JSX.Element {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const [filter, setFilter] = createSignal("")

  useOverlay({
    visible: props.visible,
    onClose: () => {
      setFilter("")
      props.onClose()
    },
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "backspace") {
        setFilter((f) => f.slice(0, -1))
        return
      }
      if (name === "space" && !key.ctrl && !key.meta) {
        setFilter((f) => `${f} `)
        return
      }
      if (name.length === 1 && !key.ctrl && !key.meta) {
        const char = key.shift ? name.toUpperCase() : name
        setFilter((f) => f + char)
        return
      }
    },
  })

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    if (needle === "") return HELP_ENTRIES
    return HELP_ENTRIES.filter(
      (e) => fuzzyMatch(needle, e.key) || fuzzyMatch(needle, e.desc) || fuzzyMatch(needle, e.group),
    )
  })

  const grouped = createMemo(() => {
    const groups: { label: string; entries: readonly HelpEntry[] }[] = []
    for (const entry of filtered()) {
      let group = groups.find((g) => g.label === entry.group)
      if (group === undefined) {
        group = { label: entry.group, entries: [] }
        groups.push(group)
      }
      group.entries = [...group.entries, entry]
    }
    return groups
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
              Keybindings
            </text>
          </box>
          <Show when={filter() !== ""}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>
                Filter: {filter()}
                {"\u2588"}
              </text>
            </box>
          </Show>
          <scrollbox
            flexGrow={1}
            maxHeight={Math.floor(dims().height / 3)}
            verticalScrollbarOptions={{ visible: false }}
          >
            <For each={grouped()}>
              {(group) => (
                <box flexDirection="column" paddingLeft={1} paddingTop={1}>
                  <text fg={theme().textMuted} attributes={TextAttributes.BOLD}>
                    {group.label}
                  </text>
                  <For each={group.entries}>
                    {(entry) => (
                      <box flexDirection="row" gap={1} paddingLeft={1}>
                        <text fg={theme().accent} flexShrink={0} wrapMode="none" width={22}>
                          {entry.key}
                        </text>
                        <text fg={theme().text} wrapMode="word">
                          {entry.desc}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">{"type to filter \u00b7 esc to close"}</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

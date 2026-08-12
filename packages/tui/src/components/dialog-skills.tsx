/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { fuzzyMatch } from "./fuzzy"
import { SLASH_COMMANDS, type SlashCommand } from "./prompt-autocomplete"

const COMMAND_CATEGORY: Readonly<Record<string, string>> = {
  models: "Model",
  mode: "Model",
  agents: "Agent",
  theme: "View",
  doctor: "Info",
  status: "Session",
  clear: "Session",
  cost: "Info",
  copy: "Session",
  context: "Info",
  version: "Info",
  help: "Info",
  skills: "Info",
  compact: "Session",
  summarize: "Session",
  thinking: "View",
  conceal: "View",
  export: "Session",
  exit: "App",
  abort: "App",
}

const CATEGORY_ORDER: readonly string[] = [
  "Model",
  "Agent",
  "Session",
  "View",
  "Input",
  "Info",
  "App",
  "Other",
]

function categoryRank(label: string): number {
  const idx = CATEGORY_ORDER.indexOf(label)
  return idx === -1 ? CATEGORY_ORDER.length : idx
}

function categoryOf(cmd: SlashCommand): string {
  return COMMAND_CATEGORY[cmd.name] ?? "Other"
}

type GroupedEntry = { cmd: SlashCommand; index: number }
type Group = { label: string; entries: GroupedEntry[] }

export function DialogSkills(props: { visible: () => boolean; onClose: () => void }): JSX.Element {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    if (needle === "") return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (cmd) =>
        fuzzyMatch(needle, cmd.name) ||
        fuzzyMatch(needle, cmd.description) ||
        fuzzyMatch(needle, categoryOf(cmd)),
    )
  })

  useOverlay({
    visible: props.visible,
    onClose: () => {
      setFilter("")
      setSelected(0)
      props.onClose()
    },
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "up") {
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      if (name === "down") {
        setSelected((s) => Math.min(Math.max(0, filtered().length - 1), s + 1))
        return
      }
      if (name === "return") {
        props.onClose()
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

  const grouped = createMemo(() => {
    const groups: Group[] = []
    filtered().forEach((cmd, index) => {
      const label = categoryOf(cmd)
      let group = groups.find((g) => g.label === label)
      if (group === undefined) {
        group = { label, entries: [] }
        groups.push(group)
      }
      group.entries.push({ cmd, index })
    })
    groups.sort((a, b) => categoryRank(a.label) - categoryRank(b.label))
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
              {"Skills & Commands"}
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
          <Show when={filtered().length === 0}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>No skills available</text>
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
                    {(entry) => {
                      const isSel = () => entry.index === selected()
                      return (
                        <box
                          flexDirection="row"
                          gap={1}
                          paddingLeft={1}
                          backgroundColor={isSel() ? theme().selectionBg : undefined}
                        >
                          <text
                            fg={isSel() ? theme().selectionFg : theme().accent}
                            flexShrink={0}
                            wrapMode="none"
                            width={14}
                          >
                            {`/${entry.cmd.name}`}
                          </text>
                          <text fg={isSel() ? theme().selectionFg : theme().text} wrapMode="none">
                            {entry.cmd.description}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">
              {
                "type filter · ↑/↓ navigate · enter close · esc"
              }
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}

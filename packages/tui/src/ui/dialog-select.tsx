import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { type DialogEntry, type DialogSelectOption, useDialog } from "../context/dialog"
import { useTheme } from "../context/theme"

export function DialogSelect(props: { entry: DialogEntry }): JSX.Element {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [filter, setFilter] = createSignal("")

  const options = createMemo<readonly DialogSelectOption<unknown>[]>(
    () => props.entry.options ?? [],
  )

  const filtered = createMemo<readonly DialogSelectOption<unknown>[]>(() => {
    const needle = filter().toLowerCase()
    if (needle === "") return options()
    return options().filter((opt) => opt.title.toLowerCase().includes(needle))
  })

  function clampIndex(idx: number, len: number): number {
    if (len === 0) return 0
    if (idx < 0) return 0
    if (idx >= len) return len - 1
    return idx
  }

  useKeyboard((key) => {
    const opts = filtered()
    const current = selected()

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      if (opts.length === 0) return
      setSelected(clampIndex(current - 1, opts.length))
      return
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      if (opts.length === 0) return
      setSelected(clampIndex(current + 1, opts.length))
      return
    }
    if (key.name === "return") {
      if (opts.length === 0) return
      const opt = opts[current]
      if (opt !== undefined && opt.disabled !== true) {
        dialog.resolve(props.entry, opt.value)
      }
      return
    }
    if (key.name === "escape") {
      dialog.resolve(props.entry, undefined)
      return
    }
    if (key.name === "backspace") {
      setFilter((prev) => prev.slice(0, -1))
      setSelected(0)
      return
    }
    if (key.name === "space" && !key.ctrl && !key.meta) {
      setFilter((prev) => `${prev} `)
      setSelected(0)
      return
    }
    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      const char = key.shift ? key.name.toUpperCase() : key.name
      setFilter((prev) => prev + char)
      setSelected(0)
      return
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme().text}>
        {props.entry.title}
      </text>
      <Show when={filter() !== ""}>
        <text fg={theme().textMuted}>Filter: {filter()}</text>
      </Show>
      <box flexDirection="column" gap={0}>
        <For each={filtered()}>
          {(opt, idx) => (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={idx() === selected() ? theme().selectionBg : undefined}
            >
              <text fg={idx() === selected() ? theme().accent : theme().textMuted}>
                {idx() === selected() ? "\u25b8" : " "}
              </text>
              <text
                fg={
                  idx() === selected()
                    ? theme().text
                    : opt.disabled === true
                      ? theme().textMuted
                      : theme().text
                }
                attributes={idx() === selected() ? TextAttributes.BOLD : undefined}
              >
                {opt.title}
              </text>
              <Show when={opt.description !== undefined}>
                <text fg={theme().textMuted}>{opt.description}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
      <text fg={theme().textMuted}>{"enter to select \u00b7 esc to cancel"}</text>
    </box>
  )
}

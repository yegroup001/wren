import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, type JSX, Show } from "solid-js"
import { type DialogEntry, useDialog } from "../context/dialog"
import { useTheme } from "../context/theme"

export function DialogPrompt(props: { entry: DialogEntry }): JSX.Element {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [text, setText] = createSignal(props.entry.value ?? "")
  const [cursor, setCursor] = createSignal(text().length)

  useKeyboard((key) => {
    if (key.name === "return") {
      dialog.resolve(props.entry, text())
      return
    }
    if (key.name === "escape") {
      dialog.resolve(props.entry, undefined)
      return
    }
    if (key.name === "backspace") {
      const pos = cursor()
      const t = text()
      if (pos <= 0) return
      setText(t.slice(0, pos - 1) + t.slice(pos))
      setCursor(pos - 1)
      return
    }
    if (key.name === "left") {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (key.name === "right") {
      setCursor((c) => Math.min(text().length, c + 1))
      return
    }
    if (key.name === "home") {
      setCursor(0)
      return
    }
    if (key.name === "end") {
      setCursor(text().length)
      return
    }
    if (key.name === "space" && !key.ctrl && !key.meta) {
      const pos = cursor()
      const t = text()
      setText(`${t.slice(0, pos)} ${t.slice(pos)}`)
      setCursor(pos + 1)
      return
    }
    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      const char = key.shift ? key.name.toUpperCase() : key.name
      const pos = cursor()
      const t = text()
      setText(t.slice(0, pos) + char + t.slice(pos))
      setCursor(pos + 1)
      return
    }
  })

  const displayText = (): string => {
    const t = text()
    const pos = cursor()
    return `${t.slice(0, pos)}\u2588${t.slice(pos)}`
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme().text}>
        {props.entry.title}
      </text>
      <Show when={props.entry.description !== undefined}>
        <text fg={theme().textMuted}>{props.entry.description}</text>
      </Show>
      <box
        border
        borderColor={theme().borderActive}
        paddingBottom={0}
        paddingTop={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <Show
          when={text() !== ""}
          fallback={<text fg={theme().textMuted}>{props.entry.placeholder ?? "Enter text"}</text>}
        >
          <text fg={theme().text} wrapMode="word">
            {displayText()}
          </text>
        </Show>
      </box>
      <text fg={theme().textMuted}>
        {"enter to submit \u00b7 esc to cancel \u00b7 \u2190\u2192 home end"}
      </text>
    </box>
  )
}

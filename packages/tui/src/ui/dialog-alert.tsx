import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { JSX } from "solid-js"
import { type DialogEntry, useDialog } from "../context/dialog"
import { useTheme } from "../context/theme"

export function DialogAlert(props: { entry: DialogEntry }): JSX.Element {
  const dialog = useDialog()
  const { theme } = useTheme()

  useKeyboard((key) => {
    if (key.name === "return" || key.name === "escape") {
      dialog.resolve(props.entry, undefined)
      return
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme().text}>
        {props.entry.title}
      </text>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>{props.entry.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: terminal UI, not web */}
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme().primary}
          onMouseUp={() => dialog.resolve(props.entry, undefined)}
        >
          <text fg={theme().background}>ok</text>
        </box>
      </box>
    </box>
  )
}

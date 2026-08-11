import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, type JSX } from "solid-js"
import { type DialogEntry, useDialog } from "../context/dialog"
import { useTheme } from "../context/theme"

export function DialogConfirm(props: { entry: DialogEntry }): JSX.Element {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [active, setActive] = createSignal<"confirm" | "cancel">("confirm")

  useKeyboard((key) => {
    if (key.name === "return") {
      dialog.resolve(props.entry, active() === "confirm")
      return
    }
    if (key.name === "left" || key.name === "right" || key.name === "tab") {
      setActive((prev) => (prev === "confirm" ? "cancel" : "confirm"))
      return
    }
    if (key.name === "escape") {
      dialog.resolve(props.entry, undefined)
      return
    }
  })

  const cancelButton = props.entry.label ?? "cancel"

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme().text}>
        {props.entry.title}
      </text>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>{props.entry.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={["cancel", "confirm"] as const}>
          {(key) => (
            <box
              // biome-ignore lint/a11y/noStaticElementInteractions: terminal UI
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === active() ? theme().primary : undefined}
              onMouseUp={() => dialog.resolve(props.entry, key === "confirm")}
            >
              <text fg={key === active() ? theme().background : theme().textMuted}>
                {key === "cancel" ? cancelButton : "confirm"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

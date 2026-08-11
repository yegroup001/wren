import { RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, type JSX, Match, Show, Switch } from "solid-js"
import { type DialogEntry, useDialog } from "../context/dialog"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { DialogAlert } from "./dialog-alert"
import { DialogConfirm } from "./dialog-confirm"
import { DialogPrompt } from "./dialog-prompt"
import { DialogSelect } from "./dialog-select"

function DialogBackdrop(props: { children: JSX.Element }): JSX.Element {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  // Escape is delegated to each dialog component; only guard ctrl/meta here.
  useKeyboard((key) => {
    if (key.name === "c" && key.ctrl) return
    if (key.ctrl || key.meta) {
      key.preventDefault()
      key.stopPropagation()
    }
  })

  return (
    <box
      position="absolute"
      zIndex={3000}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      paddingTop={Math.floor(dimensions().height / 4)}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        width={Math.min(60, dimensions().width - 2)}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme().backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function DialogContent(props: { entry: DialogEntry }): JSX.Element {
  return (
    <Switch fallback={<text></text>}>
      <Match when={props.entry.type === "select"}>
        <DialogSelect entry={props.entry} />
      </Match>
      <Match when={props.entry.type === "confirm"}>
        <DialogConfirm entry={props.entry} />
      </Match>
      <Match when={props.entry.type === "prompt"}>
        <DialogPrompt entry={props.entry} />
      </Match>
      <Match when={props.entry.type === "alert"}>
        <DialogAlert entry={props.entry} />
      </Match>
    </Switch>
  )
}

export function DialogHost(): JSX.Element {
  const dialog = useDialog()
  const top = createMemo(() => {
    const s = dialog.stack()
    return s.length > 0 ? s[s.length - 1] : undefined
  })

  useOverlay({
    visible: () => top() !== undefined,
    onClose: () => {
      const entry = top()
      if (entry !== undefined) dialog.resolve(entry, undefined)
    },
  })

  return (
    <Show when={top()}>
      {(entry) => (
        <DialogBackdrop>
          <DialogContent entry={entry()} />
        </DialogBackdrop>
      )}
    </Show>
  )
}

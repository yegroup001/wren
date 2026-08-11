import { type JSX, Match, type ParentProps, Show, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useModal } from "../context/modal"

/**
 * Renders the currently open full-screen modal as an overlay.
 *
 * Modal dialogs must NOT replace the underlying route: unmounting the session
 * subtree destroys the prompt's EditBuffer, and restoring focus after close
 * then hits "EditBuffer is destroyed". Like DialogBackdrop, this overlays the
 * content with an absolutely positioned full-screen layer instead.
 */
export function ModalHost(): JSX.Element {
  const modal = useModal()
  const dims = useTerminalDimensions()
  return (
    <Show when={modal.content()}>
      {(c) => (
        <box position="absolute" zIndex={3500} left={0} top={0} width={dims().width} height={dims().height}>
          {c()()}
        </box>
      )}
    </Show>
  )
}

/**
 * Replaces children with the open modal, mirroring the App root structure.
 * Test harnesses use this instead of duplicating the Switch logic.
 */
export function ModalSwitch(props: ParentProps): JSX.Element {
  const modalContent = useModal().content
  return (
    <Switch>
      <Match when={modalContent() !== null}>
        <ModalHost />
      </Match>
      <Match when={true}>
        <box flexGrow={1}>{props.children}</box>
      </Match>
    </Switch>
  )
}

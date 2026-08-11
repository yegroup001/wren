import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createRenderEffect, onCleanup } from "solid-js"
import { useKeymap } from "../keymap"

/**
 * Unified overlay management hook.
 *
 * When `visible()` is true:
 * 1. Synchronously pushes "modal" keymap mode (createRenderEffect — safe for signal updates)
 * 2. Blurs the focused renderable (createEffect — safe for side effects)
 * 3. Captures ALL keys: preventDefault + stopPropagation to prevent textarea key leak
 * 4. Handles Escape → onClose()
 * 5. Delegates non-Escape keys to onKey callback
 *
 * When `deferred?.()` is true (e.g. a nested dialog is open), key capture is skipped
 * so the nested dialog receives keys normally.
 *
 * Usage:
 *   useOverlay({
 *     visible: () => myDialogVisible(),
 *     onClose: () => setMyDialogVisible(false),
 *     onKey: (key) => { /* handle up/down/return/etc *\/ },
 *   })
 */
export function useOverlay(props: {
  visible: () => boolean
  onClose: () => void
  onKey?: (key: KeyEvent) => void
  deferred?: () => boolean
}): void {
  const keymap = useKeymap()

  // Synchronously push modal mode when visible.
  // createRenderEffect runs during render phase — safe for pure signal updates.
  createRenderEffect(() => {
    if (!props.visible()) return
    const pop = keymap.pushMode("modal")
    onCleanup(pop)
  })

  // Blur focused renderable when overlay becomes visible.
  // createEffect runs in commit phase — safe for side effects like blur().
  createEffect(() => {
    if (!props.visible()) return
    keymap.blurFocused()
  })

  // Single keyboard handler — captures all keys when visible.
  useKeyboard((key) => {
    if (!props.visible()) return
    if (props.deferred?.()) return

    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      props.onClose()
      return
    }

    // When onKey is provided, capture all keys and forward them.
    // When onKey is NOT provided (e.g. DialogHost), let keys pass through
    // so sub-components with their own useKeyboard handlers can receive them.
    if (props.onKey !== undefined) {
      key.preventDefault()
      key.stopPropagation()
      props.onKey(key)
    }
  })
}

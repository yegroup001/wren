import {
  type Accessor,
  createContext,
  createSignal,
  type JSX,
  type ParentProps,
  useContext,
} from "solid-js"

// ModalProvider renders a full-screen modal INSTEAD of the main content.
//
// The underlying @opentui renderer (Zig native layout) does not position
// absolutely-positioned overlays correctly — dialog boxes drawn as an
// `position: "absolute"` overlay end up misplaced or clipped. Replacing the
// main content via Switch (the same mechanism route switching uses, which the
// renderer handles correctly) is the reliable way to show a dialog.

export type ModalContext = {
  /** Currently open modal content factory, or null when no modal is open. */
  readonly content: Accessor<(() => JSX.Element) | null>
  readonly open: (content: () => JSX.Element) => void
  readonly close: () => void
}

const ModalContextCtx = createContext<ModalContext>()

export function ModalProvider(props: ParentProps): JSX.Element {
  const [content, setContent] = createSignal<(() => JSX.Element) | null>(null)
  const value: ModalContext = {
    content,
    open: (c) => setContent(() => c),
    close: () => setContent(null),
  }
  return <ModalContextCtx.Provider value={value}>{props.children}</ModalContextCtx.Provider>
}

export function useModal(): ModalContext {
  const ctx = useContext(ModalContextCtx)
  if (ctx === undefined) {
    throw new Error("useModal must be used within a ModalProvider")
  }
  return ctx
}

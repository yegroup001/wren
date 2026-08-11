import { createContext, createSignal, type JSX, type ParentProps, useContext } from "solid-js"

export type ThinkingMode = "collapsed" | "expanded"

type ThinkingContextValue = {
  readonly mode: () => ThinkingMode
  readonly toggle: () => void
  readonly setMode: (mode: ThinkingMode) => void
}

const defaultValue: ThinkingContextValue = {
  mode: () => "collapsed",
  toggle: () => {},
  setMode: () => {},
}

const ctx = createContext<ThinkingContextValue>(defaultValue)

export function ThinkingProvider(props: ParentProps): JSX.Element {
  const [mode, setMode] = createSignal<ThinkingMode>("collapsed")
  const value: ThinkingContextValue = {
    mode,
    toggle: () => setMode((prev) => (prev === "collapsed" ? "expanded" : "collapsed")),
    setMode,
  }
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useThinking(): ThinkingContextValue {
  return useContext(ctx)
}

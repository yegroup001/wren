import { CliRenderEvents } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  type Accessor,
  createMemo,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  type ParentProps,
} from "solid-js"
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME,
  getTheme,
  THEME_NAMES,
  type TuiTheme,
  type TuiThemeName,
} from "../theme/themes"
import { createSimpleContext } from "./helper"

export type ThemeContext = {
  readonly theme: Accessor<TuiTheme>
  readonly selected: Accessor<string>
  readonly themes: readonly string[]
  readonly set: (name: string) => boolean
  readonly mode: Accessor<"dark" | "light">
}

const { use, provider } = createSimpleContext<ThemeContext, { initialTheme?: string }>({
  name: "Theme",
  init: (props) => {
    const renderer = useRenderer()
    const [selected, setSelected] = createSignal<string>(props.initialTheme ?? "wren")
    const [mode, setMode] = createSignal<"dark" | "light">(renderer.themeMode ?? "dark")

    const theme = createMemo<TuiTheme>(() => {
      const name = selected()
      return getTheme(name) ?? DEFAULT_THEME
    })

    const handleModeChange = (next: "dark" | "light"): void => {
      setMode(next)
    }
    renderer.on(CliRenderEvents.THEME_MODE, handleModeChange)
    onCleanup(() => renderer.off(CliRenderEvents.THEME_MODE, handleModeChange))

    onMount(() => {
      void renderer
        .getPalette({ size: 16 })
        .then(() => {
          if (renderer.themeMode) setMode(renderer.themeMode)
        })
        .catch(() => {})
    })

    return {
      theme,
      selected,
      themes: THEME_NAMES,
      set: (name: string): boolean => {
        if (!getTheme(name)) return false
        setSelected(name)
        return true
      },
      mode,
    }
  },
})

export const useTheme = use

export function ThemeProvider(props: ParentProps<{ initialTheme?: string }>): JSX.Element {
  return provider(props)
}

export type { TuiTheme, TuiThemeName }
export { BUILT_IN_THEMES, DEFAULT_THEME, THEME_NAMES }

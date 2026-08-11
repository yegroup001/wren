import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../context/theme"

const SPINNER_FRAMES: Readonly<Record<string, readonly string[]>> = {
  dots: [
    "\u280b",
    "\u2819",
    "\u2839",
    "\u2838",
    "\u283c",
    "\u2834",
    "\u2826",
    "\u2827",
    "\u2807",
    "\u280f",
  ],
  line: ["-", "\\", "|", "/"],
  bar: ["=", "=", "=", "=", " ", " ", " ", " "],
  arrow: ["\u2190", "\u2196", "\u2191", "\u2197", "\u2192", "\u2198", "\u2193", "\u2199"],
  bouncing: ["\u25d0", "\u25d3", "\u25d1", "\u25d2"],
  square: ["\u2588", "\u2588", "\u2588", "\u2588", " ", " ", " ", " "],
  circle: ["\u25e0", "\u25de", "\u25d1", "\u25df"],
  toggle: ["\u25b6", "\u25c0"],
  triangle: ["\u25e1", "\u22bf", "\u25e3", "\u25e2"],
  star: ["\u2736", "\u2738", "\u2737", "\u2739"],
  grow: ["\u22ee", "\u22f0", "\u22f1", "\u22ee"],
}

export type SpinnerStyle = keyof typeof SPINNER_FRAMES

const FALLBACK_FRAMES: readonly string[] = ["\u2022"]

export function Spinner(props: {
  style?: SpinnerStyle
  color?: string
  children?: JSX.Element
  intervalMs?: number
}): JSX.Element {
  const theme = useTheme()
  const style = (): SpinnerStyle => props.style ?? "dots"
  const color = (): string => props.color ?? theme.theme().info
  const interval = (): number => props.intervalMs ?? 80

  const frames = createMemo<readonly string[]>(() => SPINNER_FRAMES[style()] ?? FALLBACK_FRAMES)
  const [frameIndex, setFrameIndex] = createSignal(0)

  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => {
      const f = frames()
      setFrameIndex((prev) => (prev + 1) % (f.length || 1))
    }, interval())
  })
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  const currentFrame = (): string => {
    const f = frames()
    return f[frameIndex() % f.length] ?? FALLBACK_FRAMES[0] ?? ""
  }

  return (
    <box flexDirection="row" gap={1}>
      <text fg={color()}>{currentFrame()}</text>
      <Show when={props.children}>
        <text fg={theme.theme().textMuted}>{props.children}</text>
      </Show>
    </box>
  )
}

export function SpinnerFrames(style: SpinnerStyle): readonly string[] {
  return SPINNER_FRAMES[style] ?? FALLBACK_FRAMES
}

export { SPINNER_FRAMES }

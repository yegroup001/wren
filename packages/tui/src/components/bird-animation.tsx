import { createSignal, For, type JSX, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"

// ─── Half-block pixel renderer ────────────────────────────────────────
// Each character cell encodes 2 vertical pixels:
//   █ = both on   ▀ = top only   ▄ = bottom only   (space) = both off
// This gives solid, chunky shapes — more recognizable than Braille dots.
function pixelsToHalfBlock(rows: readonly string[]): string[] {
  const height = rows.length
  const width = Math.max(...rows.map((r) => r.length))
  const padded = rows.map((r) => r.padEnd(width, "."))
  const blockRows = Math.ceil(height / 2)
  const result: string[] = []
  for (let br = 0; br < blockRows; br++) {
    let line = ""
    const r1 = br * 2
    const r2 = br * 2 + 1
    for (let c = 0; c < width; c++) {
      const top = r1 < height && padded[r1]?.[c] === "X"
      const bot = r2 < height && padded[r2]?.[c] === "X"
      if (top && bot) line += "█"
      else if (top) line += "▀"
      else if (bot) line += "▄"
      else line += " "
    }
    result.push(line)
  }
  return result
}

// ─── Wren (鹪鹩) pixel-art frames ─────────────────────────────────────
// Hand-crafted on a 36×14 grid (→ 7 lines of half-block text).
// Bird faces right: cocked-up tail on left, round body, head with eye
// and beak on right, two legs below. The wing is a separate 4×4 cluster
// that moves from above the body (UP) through the body (MID) to below
// (DOWN), creating a clear flapping motion.
// Animation cycle: UP → MID → DOWN → MID → ...

const WREN_UP: readonly string[] = [
  "....................................",
  ".......X............................",
  "......XX......................X.....",
  ".....XXXX....................XXX....",
  "....XXXXXX.....XXXX........XXXXX....",
  "...XXXXXXX....XXXXXX......XXXXXXX...",
  "...XXXXXXXX...XXXXXX......XX.XXXX...",
  "...XXXXXXXX....XXXX.......XXXXXXX...",
  "....XXXXXX..................XXXXX...",
  ".....XXXX.....................XXX...",
  "......XX.......................X....",
  ".......X.....XX.....................",
  ".............XX.....................",
  "....................................",
]

const WREN_MID: readonly string[] = [
  "....................................",
  ".......X............................",
  "......XX......................X.....",
  ".....XXXX....................XXX....",
  "....XXXXXX..................XXXXX...",
  "...XXXXXXX....XXXX........XXXXXXX...",
  "...XXXXXXXX..XXXXXX......XX.XXXX...",
  "...XXXXXXXX..XXXXXX......XXXXXXX...",
  "....XXXXXX....XXXX........XXXXX.....",
  ".....XXXX..................XXX......",
  "......XX.....................X......",
  ".......X.....XX.....................",
  ".............XX.....................",
  "....................................",
]

const WREN_DOWN: readonly string[] = [
  "....................................",
  ".......X............................",
  "......XX......................X.....",
  ".....XXXX....................XXX....",
  "....XXXXXX..................XXXXX...",
  "...XXXXXXX.................XXXXXXX..",
  "...XXXXXXXX................XX.XXXX..",
  "...XXXXXXXX................XXXXXXX..",
  "....XXXXXX....XXXX..........XXXXX...",
  ".....XXXX....XXXXXX..........XXX....",
  "......XX.....XXXXXX...........X.....",
  ".......X.....XXXX............XX.....",
  ".............XX..............XX.....",
  "....................................",
]

const WREN_FRAMES: readonly string[][] = [WREN_UP, WREN_MID, WREN_DOWN, WREN_MID].map(
  pixelsToHalfBlock,
)

export function BirdAnimation(props: { intervalMs?: number; color?: string }): JSX.Element {
  const theme = useTheme()
  const color = (): string => props.color ?? theme.theme().primary
  const interval = (): number => props.intervalMs ?? 220

  const [frameIndex, setFrameIndex] = createSignal(0)

  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % WREN_FRAMES.length)
    }, interval())
  })
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  const currentFrame = (): readonly string[] =>
    WREN_FRAMES[frameIndex() % WREN_FRAMES.length] ?? [""]

  return (
    <box flexDirection="column">
      <For each={currentFrame()}>{(line) => <text fg={color()}>{line}</text>}</For>
    </box>
  )
}

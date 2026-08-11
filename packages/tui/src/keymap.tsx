import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import {
  type Accessor,
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { type ToastContext, useToast } from "./ui/toast"

// --- Types -----------------------------------------------------------------

export type KeymapMode = "base" | "modal" | "prompt"

export type Binding = {
  readonly key: string
  readonly desc: string
  readonly group: string
  readonly cmd: () => void
}

export type BindingRegistration = {
  readonly mode?: KeymapMode
  readonly bindings: readonly Binding[]
  readonly enabled?: boolean
}

export type KeymapContext = {
  readonly mode: Accessor<KeymapMode>
  readonly pushMode: (mode: KeymapMode) => () => void
  readonly leaderActive: Accessor<boolean>
  readonly register: (registration: () => BindingRegistration) => () => void
  readonly dispatch: (key: KeyEvent) => void
  readonly blurFocused: () => void
}

const LEADER_KEY = "ctrl+x"
const LEADER_TIMEOUT_MS = 1000

// --- Default bindings (30+) ------------------------------------------------

export const DEFAULT_BINDINGS: readonly {
  readonly command: string
  readonly key: string
  readonly desc: string
}[] = [
  { command: "app.exit", key: "ctrl+c", desc: "Exit the application" },
  { command: "session.list", key: "<leader>l", desc: "List all sessions" },
  { command: "session.new", key: "<leader>n,ctrl+n", desc: "Back to home (new session)" },
  { command: "session.interrupt", key: "escape", desc: "Interrupt current session" },
  { command: "model.list", key: "<leader>m", desc: "List available models" },
  { command: "diff.toggle", key: "<leader>d", desc: "Toggle diff panel" },
  { command: "scroll.up", key: "ctrl+b", desc: "Scroll up half page" },
  { command: "scroll.down", key: "ctrl+d", desc: "Scroll down half page" },
  { command: "scroll.top", key: "ctrl+g,home", desc: "Scroll to top" },
  { command: "scroll.bottom", key: "<leader>g", desc: "Scroll to bottom" },
  { command: "page.up", key: "pageup", desc: "Page up" },
  { command: "page.down", key: "pagedown", desc: "Page down" },
  { command: "input.submit", key: "return", desc: "Submit prompt input" },
  {
    command: "input.newline",
    key: "shift+return,ctrl+return,alt+return,ctrl+j",
    desc: "Insert newline",
  },
  { command: "prompt.history_up", key: "up", desc: "Previous prompt history" },
  { command: "prompt.history_down", key: "down", desc: "Next prompt history" },
  { command: "command.palette", key: "ctrl+p", desc: "Show command palette" },
  { command: "command.palette_colon", key: ":", desc: "Show command palette (colon leader)" },
  { command: "help.show", key: "<leader>h", desc: "Show help" },
  { command: "diff.open", key: "<leader>v", desc: "Open diff viewer" },
  { command: "theme.next", key: "<leader>t", desc: "Cycle to next theme" },
]

// --- Key matching ----------------------------------------------------------

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: "return",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  del: "delete",
}

function normalizeKeyName(name: string): string {
  return KEY_ALIASES[name] ?? name
}

type ParsedKeySpec = {
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly key: string
}

function parseKeySpec(spec: string): ParsedKeySpec {
  const parts = spec.split("+").map((p) => p.trim())
  const ctrl = parts.includes("ctrl")
  const shift = parts.includes("shift")
  const alt = parts.includes("alt") || parts.includes("meta")
  const keyPart = parts.find((p) => !["ctrl", "shift", "alt", "meta"].includes(p)) ?? ""
  return { ctrl, shift, alt, key: normalizeKeyName(keyPart.toLowerCase()) }
}

function parseBindingSpec(spec: string): readonly ParsedKeySpec[] {
  return spec.split(",").map((s) => parseKeySpec(s.trim()))
}

function matchKey(key: KeyEvent, spec: ParsedKeySpec): boolean {
  const keyName = normalizeKeyName(key.name.toLowerCase())
  if (spec.key === "<leader>") return false
  if (keyName !== spec.key) return false
  if (key.ctrl !== spec.ctrl) return false
  if (key.shift !== spec.shift) return false
  if ((key.meta || key.option) !== spec.alt) return false
  return true
}

function matchBinding(key: KeyEvent, bindingKey: string): boolean {
  if (bindingKey.includes("<leader>")) return false
  const specs = parseBindingSpec(bindingKey)
  return specs.some((spec) => matchKey(key, spec))
}

// --- Context ---------------------------------------------------------------

const KeymapCtx = createContext<KeymapContext>()

export function KeymapProvider(props: ParentProps): JSX.Element {
  const [mode, setMode] = createSignal<KeymapMode>("base")
  const [leaderActive, setLeaderActive] = createSignal(false)
  const renderer = useRenderer()
  let toast: ToastContext | undefined
  try {
    toast = useToast()
  } catch {
    toast = undefined
  }

  const modeStack: { id: symbol; mode: KeymapMode }[] = []

  const registrations = new Set<() => BindingRegistration>()
  let leaderTimeout: ReturnType<typeof setTimeout> | undefined

  function pushMode(newMode: KeymapMode): () => void {
    const id = Symbol(newMode)
    modeStack.push({ id, mode: newMode })
    setMode(newMode)
    return () => {
      const idx = modeStack.findIndex((item) => item.id === id)
      if (idx !== -1) modeStack.splice(idx, 1)
      setMode(modeStack.at(-1)?.mode ?? "base")
    }
  }

  function register(registration: () => BindingRegistration): () => void {
    registrations.add(registration)
    return () => {
      registrations.delete(registration)
    }
  }

  function getActiveBindings(): readonly Binding[] {
    const currentMode = mode()
    const result: Binding[] = []
    for (const reg of registrations) {
      const config = reg()
      if (config.enabled === false) continue
      const regMode = config.mode ?? "base"
      if (currentMode === "modal" && regMode === "base") continue
      if (regMode !== currentMode && regMode !== "base") continue
      result.push(...config.bindings)
    }
    return result
  }

  function clearLeader(): void {
    if (leaderTimeout !== undefined) {
      clearTimeout(leaderTimeout)
      leaderTimeout = undefined
    }
    setLeaderActive(false)
  }

  function runCmd(b: Binding): void {
    try {
      b.cmd()
    } catch (err) {
      if (toast) toast.error(err)
      else console.error("[keymap]", err)
    }
  }

  function dispatch(key: KeyEvent): void {
    if (key.defaultPrevented || key.propagationStopped) return
    if (mode() !== "modal") {
      if (leaderActive()) {
        clearLeader()
        const leaderBindings = getActiveBindings().filter((b) => b.key.startsWith("<leader>"))
        for (const binding of leaderBindings) {
          const suffix = binding.key.replace(/^<leader>,?/, "").trim()
          if (suffix && matchBinding(key, suffix)) {
            key.preventDefault()
            key.stopPropagation()
            runCmd(binding)
            return
          }
        }
        return
      }

      if (key.ctrl && key.name.toLowerCase() === "x") {
        key.preventDefault()
        key.stopPropagation()
        setLeaderActive(true)
        leaderTimeout = setTimeout(() => clearLeader(), LEADER_TIMEOUT_MS)
        return
      }
    } else if (leaderActive()) clearLeader()

    const bindings = getActiveBindings()
    for (const binding of bindings) {
      if (binding.key.startsWith("<leader>")) continue
      if (matchBinding(key, binding.key)) {
        key.preventDefault()
        key.stopPropagation()
        runCmd(binding)
        return
      }
    }
  }

  useKeyboard((key) => dispatch(key))
  onCleanup(() => clearLeader())

  function blurFocused(): void {
    const focused = renderer.currentFocusedRenderable
    if (focused !== null) renderer.blurRenderable(focused)
  }

  const context: KeymapContext = {
    mode,
    pushMode,
    leaderActive,
    register,
    dispatch,
    blurFocused,
  }

  return <KeymapCtx.Provider value={context}>{props.children}</KeymapCtx.Provider>
}

export function useKeymap(): KeymapContext {
  const value = useContext(KeymapCtx)
  if (value === undefined) {
    throw new Error("useKeymap must be used within a KeymapProvider")
  }
  return value
}

export function useBindings(registration: () => BindingRegistration): void {
  const keymap = useKeymap()
  const cleanup = keymap.register(registration)
  onCleanup(cleanup)
}

export function useModePush(mode: KeymapMode): void {
  const keymap = useKeymap()
  const pop = keymap.pushMode(mode)
  onCleanup(pop)
}

export { LEADER_KEY, LEADER_TIMEOUT_MS }

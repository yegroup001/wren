/**
 * Terminal utility shims — previously from @wren/stubs/ink.
 *
 * The engine's vendored source imports these from @anthropic/ink (a React
 * terminal renderer). The headless engine never renders UI; these no-op
 * implementations keep the import graph loadable without pulling in React.
 */

// --- Types ---
export type Key = {
  readonly name: string
  readonly sequence?: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly paste?: boolean
  readonly return?: boolean
  readonly escape?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly tab?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
}

export type KeyboardEvent = { readonly key: Key }
export type ClickEvent = { readonly button: string }
export type FocusEvent = { readonly type: string }
export type DOMElement = { readonly nodeName: string; toString(): string }
export type Styles = Readonly<Record<string, unknown>>
export type TextStyles = Readonly<Record<string, unknown>>
export type TextProps = { readonly children?: unknown }
export type RenderOptions = Readonly<Record<string, unknown>>
export type TerminalNotification = {
  readonly type: string
  notifyITerm2(opts: { message: string; title?: string; notificationType: string }): void
  notifyBell(): void
  notifyKitty(opts: { message: string; title?: string; notificationType: string; id: number }): void
  notifyGhostty(opts: { message: string; title?: string; notificationType: string }): void
}
export type InputEvent = { readonly type: string }
export type ThemeName = string
export type RGBColor = unknown
export type RGBColorasRGBColorString = string
export type ScrollBoxHandle = {
  scrollToBottom(): void
  scrollToTop(): void
  scrollDown(n?: number): void
  scrollUp(n?: number): void
}
export type ColorChain = ((s: string) => string) & { readonly [k: string]: ColorChain }
export type ResolveResult =
  | { type: "match"; action: string }
  | { type: "no_match" }
  | { type: "partial" }
export type ChordResolveResult = unknown
export type ParsedBinding = unknown
export type ParsedKeystroke = unknown
export type KeybindingContextName = unknown
export type KeybindingBlock = unknown
export type Chord = unknown
export type KeybindingAction = unknown

// --- Components (no-op) ---
export const Text = (_props?: TextProps): null => null
export const Box = (_props?: unknown): null => null
export const Dialog = (_props?: unknown): null => null

// --- Utility functions ---
export function stringWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

export function wrapAnsi(str: string, _columns: number, _options?: unknown): string {
  return str
}

// --- Constants ---
export const supportsHyperlinks = (): boolean => false
export const supportsTabStatus = (): boolean => false

// --- Terminal state ---
export function getTerminalFocused(): boolean {
  return false
}
export function getTerminalFocusState(): boolean {
  return false
}
export function setThemeConfigCallbacks(_onTheme?: unknown, _onError?: unknown): void {}
export function measureElement(_node: DOMElement): { readonly width: number; readonly height: number } {
  return { width: 0, height: 0 }
}

// --- Color ---
function identity(s: string): string {
  return s
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(identity as any).__proto__ = null
export const color: ColorChain = identity as ColorChain

// --- Ink instances ---
export type InkInstance = {
  isAltScreenActive?: boolean
  unmount(): void
  drainStdin(): void
  detachForShutdown(): void
  enterAlternateScreen(): void
  exitAlternateScreen(): void
  pause(): void
  suspendStdin(): void
  resumeStdin(): void
  resume(): void
}
export const instances: Map<unknown, InkInstance> = new Map()

// --- Hooks (no-op) ---
export function useInput(_handler: (input: string, key: Key) => void, _options?: unknown): void {}
export function useApp(): { exit(err?: Error): void } {
  return { exit: () => {} }
}
export function useTheme(): { readonly theme: Record<string, unknown> } {
  return { theme: {} }
}
export function useSelection(): unknown {
  return null
}
export function useTerminalFocus(_handler: (focused: boolean) => void): void {}
export function useTerminalNotification(_handler: (n: TerminalNotification) => void): void {}
export function useAnimationFrame(_handler: () => void): void {}
export function subscribeTerminalFocus(_handler: (focused: boolean) => void): () => void {
  return () => {}
}
export function typeInputEvent(_event: InputEvent): void {}
export function typeDOMElement(_element: DOMElement): void {}

// --- Terminal escape codes (no-op) ---
export const DISABLE_KITTY_KEYBOARD = ""
export const DISABLE_MODIFY_OTHER_KEYS = ""
export const DBP = ""
export const DFE = ""
export const DISABLE_MOUSE_TRACKING = ""
export const EXIT_ALT_SCREEN = ""
export const SHOW_CURSOR = ""
export const CLEAR_ITERM2_PROGRESS = ""
export const CLEAR_TAB_STATUS = ""
export const CLEAR_TERMINAL_TITLE = ""
export const wrapForMultiplexer = (..._args: unknown[]): string => ""
export const useMinDisplayTime = function (..._args: unknown[]) { return null }
export const useTerminalSize = function (..._args: unknown[]) { return null }
export const useTimeout = function (..._args: unknown[]) { return null }
export const useDoublePress = function (..._args: unknown[]) { return null }
export const DOUBLE_PRESS_TIMEOUT_MS = function (..._args: unknown[]) { return null }

// --- Keybinding utilities ---
export function resolveKey(
  input: string,
  key: Key,
  contexts: string[],
  bindings: ReadonlyArray<{ context: string; bindings: Record<string, string> }>,
): ResolveResult {
  for (const ctx of contexts) {
    const block = bindings.find((b) => b.context === ctx)
    if (!block) continue
    for (const [keyPattern, action] of Object.entries(block.bindings)) {
      if (keyMatches(keyPattern, input, key)) {
        return { type: "match", action }
      }
    }
  }
  return { type: "no_match" }
}

function keyMatches(pattern: string, input: string, key: Key): boolean {
  if (pattern === "enter") return key.return === true
  if (pattern === "escape") return key.escape === true
  if (pattern === "up") return key.upArrow === true
  if (pattern === "down") return key.downArrow === true
  if (pattern === "left") return key.leftArrow === true
  if (pattern === "right") return key.rightArrow === true
  if (pattern === "tab") return key.tab === true
  if (pattern === "space") return input === " "
  if (pattern === "backspace") return key.backspace === true
  if (pattern === "delete") return key.delete === true
  if (pattern.startsWith("ctrl+")) return key.ctrl === true && input === pattern.slice(5)
  if (pattern.startsWith("shift+")) return key.shift === true && input === pattern.slice(6)
  if (pattern.startsWith("meta+")) return key.meta === true && input === pattern.slice(5)
  return input === pattern
}

export const resolveKeyWithChordState = function (..._args: unknown[]) { return null }
export const getBindingDisplayText = function (..._args: unknown[]) { return null }
export const keystrokesEqual = function (..._args: unknown[]) { return null }
export const parseKeystroke = function (..._args: unknown[]) { return null }
export const parseChord = function (..._args: unknown[]) { return null }
export const keystrokeToString = function (..._args: unknown[]) { return null }
export const chordToString = function (..._args: unknown[]) { return null }
export const keystrokeToDisplayString = function (..._args: unknown[]) { return null }
export const chordToDisplayString = function (..._args: unknown[]) { return null }
export const parseBindings = function (bindings: unknown) { return bindings }
export const useKeybinding = function (..._args: unknown[]) { return null }
export const useKeybindings = function (..._args: unknown[]) { return null }

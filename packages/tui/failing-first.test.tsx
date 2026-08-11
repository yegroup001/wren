import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { ModalSwitch } from "./src/components/modal-host"
import { Prompt } from "./src/components/prompt"
import { ClipboardProvider } from "./src/context/clipboard"
import { DialogProvider } from "./src/context/dialog"
import { LocalProvider } from "./src/context/local"
import { ModalProvider } from "./src/context/modal"
import type { Route } from "./src/context/route"
import { RouteProvider } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { DEFAULT_BINDINGS, KeymapProvider } from "./src/keymap"
import { ToastProvider } from "./src/ui/toast"

// ---------------------------------------------------------------------------
// Failing-first tests for 7 verified TUI defects.
// Each test MUST fail for the correct reason (the bug exists).
// After Wave 4 fixes, these tests will turn green.
// ---------------------------------------------------------------------------

const SESSION_ID = parseSessionId("ses_tui_ff")

type CapturedRequest = {
  readonly method: string
  readonly path: string
  readonly body: string
  readonly status: number
}

function createCapturingAdapter(requests: CapturedRequest[], defaultStatus = 200): WrenAdapter {
  const store = createTuiStore()
  store.addSession({
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "fake/model",
    permissionMode: "default",
  })
  return {
    state: store,
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const body = await request.text()
      requests.push({ method: request.method, path, body, status: defaultStatus })
      return new Response("{}", {
        status: defaultStatus,
        headers: { "content-type": "application/json" },
      })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(
  props: ParentProps<{
    adapter: WrenAdapter
    initialRoute?: Route
  }>,
): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute ?? { type: "session", sessionId: SESSION_ID }}>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider initialCwd="/tmp" initialModel="fake/model">
            <ClipboardProvider>
              <DialogProvider>
                <ToastProvider>
                  <KeymapProvider>
                    <ModalProvider>
                      <ModalSwitch>{props.children}</ModalSwitch>
                    </ModalProvider>
                  </KeymapProvider>
                </ToastProvider>
              </DialogProvider>
            </ClipboardProvider>
          </LocalProvider>
        </ThemeProvider>
      </StoreProvider>
    </RouteProvider>
  )
}

// ===========================================================================
// Defect 1: Input cleared on failed submit
// ===========================================================================

describe("failing-first: prompt input cleared on failed submit", () => {
  test("prompt.tsx should not clear input before checking response", () => {
    const source = readFileSync(join(import.meta.dir, "src", "components", "prompt.tsx"), "utf8")
    expect(source).toContain("if (response.ok)")
    expect(source).toContain("if (response.ok) {")
    const submitSection = source.slice(source.indexOf("const response = await adapter.fetch"))
    expect(submitSection).toContain("if (response.ok) {")
    expect(submitSection).toContain("textareaRef?.clear()")
    const clearIdx = submitSection.indexOf("textareaRef?.clear()")
    const okIdx = submitSection.indexOf("if (response.ok)")
    expect(okIdx).toBeLessThan(clearIdx)
  })
})

// ===========================================================================
// Defect 2: ctrl+d both exits app and scrolls transcript
// ===========================================================================

describe("failing-first: ctrl+d keymap conflict", () => {
  test("ctrl+d should not be bound to both app exit and scroll down", () => {
    const exitBinding = DEFAULT_BINDINGS.find(
      (b: { command: string; key: string }) => b.command === "app.exit",
    )
    const scrollBinding = DEFAULT_BINDINGS.find(
      (b: { command: string; key: string }) => b.command === "scroll.down",
    )

    expect(exitBinding?.key).not.toContain("ctrl+d")
    expect(scrollBinding?.key).toContain("ctrl+d")

    const exitKeys = exitBinding?.key.split(",").map((k: string) => k.trim()) ?? []
    const scrollKeys = scrollBinding?.key.split(",").map((k: string) => k.trim()) ?? []
    const overlap = exitKeys.filter((k: string) => scrollKeys.includes(k))
    expect(overlap).not.toContain("ctrl+d")
  })
})

// ===========================================================================
// Defect 3: Declared keybindings not wired
// ===========================================================================

describe("failing-first: declared keybindings not wired", () => {
  test("DEFAULT_BINDINGS should not declare unwired commands", () => {
    const removedCommands = [
      "session_new",
      "session_compact",
      "theme_list",
      "sidebar_toggle",
      "status_view",
      "todo_toggle",
      "editor_open",
      "session_export",
      "variant_cycle",
      "toggle_animations",
      "fullscreen",
    ]

    for (const cmd of removedCommands) {
      const binding = DEFAULT_BINDINGS.find((b: { command: string }) => b.command === cmd)
      expect(binding).toBeUndefined()
    }
  })
})

// ===========================================================================
// Defect 4: Shell/mode hints shown when unsupported
// ===========================================================================

describe("failing-first: false shell/mode hints in session prompt", () => {
  test("session prompt should not show 'Tab mode' or '! shell' when shell mode is not implemented", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const frame = setup.captureCharFrame()

    // BUG: prompt-shell.tsx:93-99 shows "Tab mode" and "! shell" by default
    // even though shellMode is hardcoded false and no shell wiring exists.
    // After fix: these hints should not appear in session prompt.
    expect(frame).not.toContain("Tab mode")
    expect(frame).not.toContain("! shell")

    setup.renderer.destroy()
  })
})

// ===========================================================================
// Defect 5: /models set --project scope ignored
// ===========================================================================

describe("failing-first: /models set --project scope ignored", () => {
  test("prompt.tsx should reject unsupported scope instead of silently dropping it", () => {
    const source = readFileSync(join(import.meta.dir, "src", "components", "prompt.tsx"), "utf8")
    expect(source).toContain("Scope not supported")
    expect(source).toContain("cmd.scope")
    expect(source).toContain('cmd.scope === "workspace"')
  })
})

// ===========================================================================
// Defect 6: Dialog escape returns null not undefined
// ===========================================================================

describe("failing-first: dialog prompt escape returns null not undefined", () => {
  test("DialogPrompt should resolve to undefined on escape, not null", () => {
    // BUG: dialog-prompt.tsx:20-22 previously resolved null on escape, but
    // context/dialog.tsx:60 types prompt() as Promise<string | undefined>.
    // After fix: DialogPrompt resolves undefined, matching the type contract.

    const srcDir = join(import.meta.dir, "src")
    const promptSource = readFileSync(join(srcDir, "ui", "dialog-prompt.tsx"), "utf8")
    expect(promptSource).not.toContain(", null)")
    expect(promptSource).toMatch(/resolve\([^)]*,\s*undefined\)/)

    const contextSource = readFileSync(join(srcDir, "context", "dialog.tsx"), "utf8")
    expect(contextSource).toContain("Promise<string | undefined>")
  })
})

// ===========================================================================
// Defect 7: Dead model-config.ts has no callers
// ===========================================================================

describe("failing-first: dead model-config.ts has no callers", () => {
  test("model-config.ts should not exist after cleanup", () => {
    const modelConfigPath = join(import.meta.dir, "src", "model-config.ts")
    expect(existsSync(modelConfigPath)).toBe(false)
  })
})

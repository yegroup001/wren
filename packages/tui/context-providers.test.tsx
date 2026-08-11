import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { ModalHost, ModalSwitch } from "./src/components/modal-host"
import { ClipboardProvider, useClipboard } from "./src/context/clipboard"
import { DialogProvider, useDialog } from "./src/context/dialog"
import { LocalProvider, useLocal } from "./src/context/local"
import { ModalProvider } from "./src/context/modal"
import { type Route, RouteProvider, useRoute } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { DEFAULT_BINDINGS, KeymapProvider } from "./src/keymap"
import type { TuiTheme } from "./src/theme/themes"
import { BUILT_IN_THEMES, DEFAULT_THEME, getTheme, THEME_NAMES } from "./src/theme/themes"
import { ToastProvider } from "./src/ui/toast"

function createMockAdapter(): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(): Promise<Response> {
      return new Response("{}", { status: 200 })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(
  props: ParentProps<{ adapter?: WrenAdapter; initialRoute?: Route }>,
): JSX.Element {
  const adapter = props.adapter ?? createMockAdapter()
  return (
    <RouteProvider initialRoute={props.initialRoute}>
      <StoreProvider adapter={adapter}>
        <ThemeProvider>
          <LocalProvider>
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

function requireContext<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} was not initialized`)
  return value
}

describe("TUI theme system", () => {
  test("has 5 built-in themes", () => {
    expect(THEME_NAMES.length).toBeGreaterThanOrEqual(5)
    expect(THEME_NAMES).toContain("wren")
    expect(THEME_NAMES).toContain("dracula")
    expect(THEME_NAMES).toContain("catppuccin")
    expect(THEME_NAMES).toContain("nord")
    expect(THEME_NAMES).toContain("tokyonight")
  })

  test("each theme has required color fields", () => {
    const requiredFields: (keyof TuiTheme)[] = [
      "primary",
      "accent",
      "error",
      "warning",
      "success",
      "info",
      "text",
      "textMuted",
      "background",
      "backgroundPanel",
      "backgroundElement",
      "border",
      "borderActive",
      "diffAdded",
      "diffRemoved",
      "markdownHeading",
      "markdownLink",
      "markdownCode",
      "syntaxComment",
      "syntaxKeyword",
      "syntaxFunction",
      "syntaxString",
      "user",
      "assistant",
      "thinking",
      "tool",
      "toolBash",
      "toolRead",
      "toolWrite",
      "toolWeb",
      "toolTodo",
      "toolDefault",
    ]
    for (const name of THEME_NAMES) {
      const theme = BUILT_IN_THEMES[name]
      for (const field of requiredFields) {
        const value = theme[field]
        expect(typeof value).toBe("string")
        expect(value.length).toBeGreaterThan(0)
      }
    }
  })

  test("getTheme returns theme by name", () => {
    expect(getTheme("dracula")).toBeDefined()
    expect(getTheme("nonexistent")).toBeUndefined()
  })

  test("default theme is wren", () => {
    expect(DEFAULT_THEME).toBe(BUILT_IN_THEMES.wren)
  })

  test("default theme follows the neutral dark design tokens", () => {
    expect(DEFAULT_THEME.background).toBe("#0B0D10")
    expect(DEFAULT_THEME.backgroundPanel).toBe("#12161B")
    expect(DEFAULT_THEME.backgroundElement).toBe("#1A2027")
    expect(DEFAULT_THEME.border).toBe("#3D4D5C")
    expect(DEFAULT_THEME.accent).toBe("#B8A1FF")
  })
})

describe("TUI keymap system", () => {
  test("has 20+ default bindings", () => {
    expect(DEFAULT_BINDINGS.length).toBeGreaterThanOrEqual(20)
  })

  test("default bindings include essential commands", () => {
    const commands = DEFAULT_BINDINGS.map((b) => b.command)
    expect(commands).toContain("app.exit")
    expect(commands).toContain("session.list")
    expect(commands).toContain("model.list")
    expect(commands).toContain("input.submit")
    expect(commands).toContain("input.newline")
    expect(commands).toContain("scroll.up")
    expect(commands).toContain("scroll.down")
  })

  test("default bindings omit unsupported affordance commands", () => {
    const commands = DEFAULT_BINDINGS.map((b) => b.command)
    expect(commands).not.toContain("agent.list")
    expect(commands).not.toContain("theme.cycle")
    expect(commands).not.toContain("messages.copy")
    expect(commands).not.toContain("fullscreen")
    expect(commands).not.toContain("session_compact")
    expect(commands).not.toContain("theme_list")
    expect(commands).not.toContain("sidebar_toggle")
    expect(commands).not.toContain("toggle_animations")
  })

  test("each binding has key, command, and desc", () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(typeof binding.command).toBe("string")
      expect(typeof binding.key).toBe("string")
      expect(typeof binding.desc).toBe("string")
      expect(binding.key.length).toBeGreaterThan(0)
      expect(binding.desc.length).toBeGreaterThan(0)
    }
  })

  test("leader key prefix is used in some bindings", () => {
    const leaderBindings = DEFAULT_BINDINGS.filter((b) => b.key.includes("<leader>"))
    expect(leaderBindings.length).toBeGreaterThanOrEqual(5)
  })
})

describe("TUI dialog context", () => {
  test("dialog stack push and pop via provider", async () => {
    let dialogApi: ReturnType<typeof useDialog> | undefined
    const DialogProbe = (): JSX.Element => {
      dialogApi = useDialog()
      return <text>probe</text>
    }

    const setup = await testRender(
      () => (
        <TestProviders>
          <DialogProbe />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const dialog = requireContext(dialogApi, "Dialog API")
    const promise = dialog.confirm("Test", "Are you sure?")
    expect(dialog.stack().length).toBe(1)
    dialog.pop()
    await promise
    expect(dialog.stack().length).toBe(0)
    setup.renderer.destroy()
  })

  test("dialog alert resolves on pop", async () => {
    let dialogApi: ReturnType<typeof useDialog> | undefined
    const DialogProbe = (): JSX.Element => {
      dialogApi = useDialog()
      return <text>probe</text>
    }

    const setup = await testRender(
      () => (
        <TestProviders>
          <DialogProbe />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const dialog = requireContext(dialogApi, "Dialog API")
    const promise = dialog.alert("Title", "Message")
    expect(dialog.stack().length).toBe(1)
    dialog.pop()
    await promise
    expect(dialog.stack().length).toBe(0)
    setup.renderer.destroy()
  })
})

describe("TUI route context", () => {
  test("route starts at home by default", async () => {
    let routeApi: ReturnType<typeof useRoute> | undefined
    const RouteProbe = (): JSX.Element => {
      routeApi = useRoute()
      return <text>probe</text>
    }

    const setup = await testRender(
      () => (
        <TestProviders>
          <RouteProbe />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const route = requireContext(routeApi, "Route API")
    expect(route.route()).toEqual({ type: "home" })
    setup.renderer.destroy()
  })

  test("route navigates to session and back", async () => {
    let routeApi: ReturnType<typeof useRoute> | undefined
    const RouteProbe = (): JSX.Element => {
      routeApi = useRoute()
      return <text>probe</text>
    }

    const sessionId = parseSessionId("ses_test")
    const setup = await testRender(
      () => (
        <TestProviders initialRoute={{ type: "session", sessionId }}>
          <RouteProbe />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const route = requireContext(routeApi, "Route API")
    expect(route.route()).toEqual({ type: "session", sessionId })
    route.navigate({ type: "home" })
    expect(route.route()).toEqual({ type: "home" })
    setup.renderer.destroy()
  })
})

describe("TUI clipboard context", () => {
  test("clipboard provider provides copy and paste functions", async () => {
    let clipboardApi: ReturnType<typeof useClipboard> | undefined
    const ClipboardProbe = (): JSX.Element => {
      clipboardApi = useClipboard()
      return <text>probe</text>
    }

    const setup = await testRender(
      () => (
        <TestProviders>
          <ClipboardProbe />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const clipboard = requireContext(clipboardApi, "Clipboard API")
    expect(typeof clipboard.copy).toBe("function")
    expect(typeof clipboard.paste).toBe("function")
    setup.renderer.destroy()
  })
})

describe("TUI local context", () => {
  test("local provider provides agent, model, variant, cwd", async () => {
    let localApi: ReturnType<typeof useLocal> | undefined
    const LocalProbe = (): JSX.Element => {
      localApi = useLocal()
      return <text>probe</text>
    }

    const setup = await testRender(
      () => (
        <TestProviders>
          <LocalProbe />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const local = requireContext(localApi, "Local API")
    expect(typeof local.agent()).toBe("string")
    expect(typeof local.model()).toBe("string")
    expect(typeof local.variant()).toBe("string")
    expect(typeof local.cwd()).toBe("string")
    local.setAgent("custom")
    expect(local.agent()).toBe("custom")
    local.setModel("custom-model")
    expect(local.model()).toBe("custom-model")
    setup.renderer.destroy()
  })

  test("local provider accepts initial cwd and model", async () => {
    let localApi: ReturnType<typeof useLocal> | undefined
    const LocalProbe = (): JSX.Element => {
      localApi = useLocal()
      return <text>probe</text>
    }

    const setup = await testRender(
      () => (
        <LocalProvider initialCwd="/tmp/project-a" initialModel="fixture/model-a">
          <LocalProbe />
        </LocalProvider>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    const local = requireContext(localApi, "Local API")
    expect(local.cwd()).toBe("/tmp/project-a")
    expect(local.model()).toBe("fixture/model-a")
    setup.renderer.destroy()
  })
})

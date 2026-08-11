import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import { createSignal, type JSX, type ParentProps, Show } from "solid-js"
import { ModalHost, ModalSwitch } from "./src/components/modal-host"
import { ClipboardProvider } from "./src/context/clipboard"
import { DialogProvider } from "./src/context/dialog"
import { LocalProvider } from "./src/context/local"
import { ModalProvider } from "./src/context/modal"
import type { Route } from "./src/context/route"
import { RouteProvider } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { KeymapProvider } from "./src/keymap"
import { Home } from "./src/routes/home"
import { Session } from "./src/routes/session"
import { ToastProvider } from "./src/ui/toast"

function createMockAdapter(): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(): Promise<Response> {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(
  props: ParentProps<{
    adapter: WrenAdapter
    initialCwd?: string
    initialModel?: string
    initialRoute?: Route
  }>,
): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute ?? { type: "home" }}>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider initialCwd={props.initialCwd} initialModel={props.initialModel}>
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

describe("Wren TUI render smoke", () => {
  test("home route renders with logo and prompt", async () => {
    const adapter = createMockAdapter()
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }}>
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Wren")
    expect(frame).toContain("Issue a local coding command")
    expect(frame).not.toContain("Tab mode")
    expect(frame).not.toContain("! shell")
    setup.renderer.destroy()
  })

  test("home route stays readable at narrow terminal width", async () => {
    const adapter = createMockAdapter()
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }}>
          <Home />
        </TestProviders>
      ),
      { width: 60, height: 20 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    expect(frame).toContain("Issue a local coding command")
    expect(lines.every((line) => line.length <= 60)).toBe(true)
    setup.renderer.destroy()
  })

  test("home prompt uses initialized local cwd and model", async () => {
    const requests: { readonly body: string; readonly path: string }[] = []
    const adapter: WrenAdapter = {
      state: createTuiStore(),
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname
        const body = await request.text()
        requests.push({ path, body })
        if (path === "/session") {
          return new Response(JSON.stringify({ id: "ses_smoke_home" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      },
      async resume(): Promise<void> {},
      async waitForIdle(): Promise<void> {},
    }
    const setup = await testRender(
      () => (
        <TestProviders
          adapter={adapter}
          initialCwd="/tmp/project-a"
          initialModel="fixture/model-a"
          initialRoute={{ type: "home" }}
        >
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("start work")
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests[0]).toEqual({
      path: "/session",
      body: JSON.stringify({
        cwd: "/tmp/project-a",
        modelId: "fixture/model-a",
        permissionMode: "auto",
        effort: "default",
      }),
    })
    setup.renderer.destroy()
  })

  test("session route renders with transcript and prompt", async () => {
    const adapter = createMockAdapter()
    const sessionId = parseSessionId("ses_smoke")
    const messageId = parseMessageId("msg_smoke")
    adapter.state.addSession({
      id: sessionId,
      cwd: "/tmp/project",
      modelId: "test/model",
      permissionMode: "default",
    })
    adapter.state.setStatus(sessionId, { type: "idle" })
    adapter.state.addMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      parts: [{ type: "text", id: parsePartId("part_smoke"), text: "Streaming answer" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId }}>
          <Session sessionId={sessionId} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Streaming answer")
    expect(frame).toContain("idle")
    setup.renderer.destroy()
  })

  test("recreates conditional renderables without native lifecycle failures", async () => {
    let setVisible!: (visible: boolean) => void
    const setup = await testRender(
      () => {
        const [visible, updateVisible] = createSignal(true)
        setVisible = updateVisible
        return (
          <box>
            <Show when={visible()}>
              <box>
                <text>conditional native text</text>
              </box>
            </Show>
          </box>
        )
      },
      { width: 40, height: 8 },
    )

    await setup.renderOnce()
    for (let index = 0; index < 25; index++) {
      setVisible(false)
      await setup.flush()
      expect(setup.captureCharFrame()).not.toContain("conditional native text")
      setVisible(true)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("conditional native text")
    }

    expect(() => setup.renderer.destroy()).not.toThrow()
  })

  test("TUI hides unsupported cloud surfaces", async () => {
    const adapter = createMockAdapter()
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }}>
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("session.share")
    expect(frame).not.toContain("console.org")
    expect(frame).not.toContain("provider.connect")
    expect(frame).not.toContain("backgroundSubagents")
    expect(frame).not.toContain("upgrade")
    setup.renderer.destroy()
  })
})

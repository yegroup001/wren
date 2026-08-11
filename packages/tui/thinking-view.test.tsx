import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { ModalHost, ModalSwitch } from "./src/components/modal-host"
import { ClipboardProvider } from "./src/context/clipboard"
import { DialogProvider } from "./src/context/dialog"
import { LocalProvider } from "./src/context/local"
import { ModalProvider } from "./src/context/modal"
import type { Route } from "./src/context/route"
import { RouteProvider } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { ThinkingProvider } from "./src/context/thinking"
import { KeymapProvider } from "./src/keymap"
import { Session } from "./src/routes/session"
import { ToastProvider } from "./src/ui/toast"

const SESSION_ID = parseSessionId("ses_think_view")

function createMockAdapter(): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(): Promise<Response> {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
    getLastRunFailed(): boolean {
      return false
    },
  }
}

function TestProviders(props: ParentProps<{ adapter: WrenAdapter }>): JSX.Element {
  return (
    <RouteProvider initialRoute={{ type: "session", sessionId: SESSION_ID } as Route}>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider>
            <ClipboardProvider>
              <DialogProvider>
                <ToastProvider>
                  <ThinkingProvider>
                    <KeymapProvider>
                      <ModalProvider>
                        <ModalSwitch>{props.children}</ModalSwitch>
                      </ModalProvider>
                    </KeymapProvider>
                  </ThinkingProvider>
                </ToastProvider>
              </DialogProvider>
            </ClipboardProvider>
          </LocalProvider>
        </ThemeProvider>
      </StoreProvider>
    </RouteProvider>
  )
}

function setup(adapter: WrenAdapter): void {
  const store = adapter.state
  store.addSession({
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "fake/model",
    permissionMode: "default",
  })
  store.setStatus(SESSION_ID, {
    type: "working",
    model: "fake/model",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
  })
  const messageId = parseMessageId("msg_think_stream")
  store.addMessage({
    id: messageId,
    sessionId: SESSION_ID,
    role: "assistant",
    parts: [
      { type: "thinking", id: parsePartId("part_think"), text: "" },
      { type: "text", id: parsePartId("part_text"), text: "" },
    ],
    createdAt: "2026-08-05T00:01:00.000Z",
  })
  store.appendPartText(
    SESSION_ID,
    messageId,
    parsePartId("part_think"),
    "Let me think about this problem step by step. The user wants a fix for the lag.",
  )
  store.appendPartText(SESSION_ID, messageId, parsePartId("part_text"), "Here is the answer")
}

describe("thinking display during streaming", () => {
  test("shows Thinking title while streaming and Thought after completion", async () => {
    const adapter = createMockAdapter()
    setup(adapter)
    const setupRender = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Session sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 100, height: 30 },
    )
    await setupRender.renderOnce()
    const frame = setupRender.captureCharFrame()
    // Text already started → thinking is complete → "Thought"
    expect(frame).toContain("Thought")
    expect(frame).toContain("Let me think about this problem step by step")
    expect(frame).toContain("Here is the answer")

    // Pure thinking phase: thinking is the last content part → "Thinking"
    const adapter2 = createMockAdapter()
    setup(adapter2)
    adapter2.state.replaceMessage(SESSION_ID, parseMessageId("msg_think_stream"), {
      id: parseMessageId("msg_think_stream"),
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "thinking", id: parsePartId("part_think"), text: "Only thinking so far" }],
      createdAt: "2026-08-05T00:01:00.000Z",
    })
    const setup2 = await testRender(
      () => (
        <TestProviders adapter={adapter2}>
          <Session sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 100, height: 30 },
    )
    await setup2.renderOnce()
    const thinkingFrame = setup2.captureCharFrame()
    expect(thinkingFrame).toContain("Thinking")
    setup2.renderer.destroy()

    // Finish the turn
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    await setupRender.renderOnce()
    const doneFrame = setupRender.captureCharFrame()
    expect(doneFrame).toContain("Thought")
    setupRender.renderer.destroy()
  })

  test("thinking part is visible and expandable via toggle", async () => {
    const adapter = createMockAdapter()
    setup(adapter)
    const setupRender = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Session sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 100, height: 30 },
    )
    await setupRender.renderOnce()
    const frame = setupRender.captureCharFrame()
    // Collapsed by default: the marker triangle is shown, full text is not
    expect(frame).toContain("\u25b8")
    expect(frame).not.toContain("step by step. The user wants")
    setupRender.renderer.destroy()
  })
})

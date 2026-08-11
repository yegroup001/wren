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

const SESSION_ID = parseSessionId("ses_flicker_e2e")

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

const TOKENS = [
  "# Streaming ",
  "Heading\n\n",
  "Some **bold** and *italic* text with `code`\n\n",
  "- item one\n",
  "- item two **strong**\n\n",
  "Done.",
]

describe("streaming frame stability", () => {
  test("frames do not alternate while streaming markdown with many tags", async () => {
    const adapter = createMockAdapter()
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
    const messageId = parseMessageId("msg_stream")
    const partId = parsePartId("part_text")
    store.addMessage({
      id: messageId,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "text", id: partId, text: "" }],
      createdAt: "2026-08-05T00:01:00.000Z",
    })

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Session sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 100, height: 30 },
    )
    await setup.renderOnce()

    for (const token of TOKENS) {
      store.appendPartText(SESSION_ID, messageId, partId, token)
      // First renderOnce processes the store update; the second paints the
      // resulting frame (elements created mid-frame appear one cycle later).
      await setup.renderOnce()
      await setup.renderOnce()
      const frameA = setup.captureCharFrame()

      // Allow the async tree-sitter worker to finish and re-render.
      await new Promise((resolve) => setTimeout(resolve, 150))
      await setup.renderOnce()
      const frameB = setup.captureCharFrame()

      const textA = normalize(frameA)
      const textB = normalize(frameB)
      // The tail must not flip between "with syntax chars" and "concealed".
      expect(textA).toBe(textB)
    }

    // Completed message: final rendering still stable after the worker settles.
    store.setStatus(SESSION_ID, { type: "idle" })
    await setup.renderOnce()
    const finalA = setup.captureCharFrame()
    await new Promise((resolve) => setTimeout(resolve, 150))
    await setup.renderOnce()
    const finalB = setup.captureCharFrame()
    expect(normalize(finalA)).toBe(normalize(finalB))

    setup.renderer.destroy()
  })
})

// Isolate the transcript region: everything left of the scrollbar column.
// The status bar, sidebar, and prompt shell contain intentional animations
// (spinners, blinking ●) that legitimately tick between frames.
function normalize(frame: string): string {
  return frame
    .split("\n")
    .map((line) => {
      const scrollbar = line.indexOf("\u2588")
      return scrollbar === -1 ? line : line.slice(0, scrollbar)
    })
    .map((line) => line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁⠂⠄⡀⢀⠠⠐⠈]/g, "X").replace(/●/g, ""))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
}

import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { ClipboardProvider } from "../context/clipboard"
import { RouteProvider } from "../context/route"
import { StoreProvider } from "../context/store"
import { ThemeProvider } from "../context/theme"
import { ToastProvider } from "../ui/toast"
import { Transcript } from "./transcript"

const SESSION_ID = parseSessionId("ses_transcript_fold")

function createAdapter(): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(): Promise<Response> {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(props: ParentProps<{ adapter: WrenAdapter }>): JSX.Element {
  return (
    <RouteProvider>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <ClipboardProvider>
            <ToastProvider>{props.children}</ToastProvider>
          </ClipboardProvider>
        </ThemeProvider>
      </StoreProvider>
    </RouteProvider>
  )
}

function framePosition(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(text)
    if (x !== -1) return { x, y }
  }
  throw new Error(`frame text not found: ${text}`)
}

describe("compaction fold on the last visible row of the scrolled transcript", () => {
  test("clicking it expands the fold", async () => {
    // The session route wraps the transcript in a bordered box with
    // overflow="hidden". The opentui hit-test clipped the bottom row of the
    // scrolled content (the hit scissor missed the border inset), so the
    // compaction fold — always the newest, bottom-most row — could never be
    // clicked. This pins the real layout so the local opentui patch cannot
    // regress.
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "source/model",
      permissionMode: "default",
    })
    for (let i = 0; i < 5; i++) {
      adapter.state.addMessage({
        id: parseMessageId(`msg_scrolled_${i}`),
        sessionId: SESSION_ID,
        role: "assistant",
        createdAt: "2026-07-08T00:00:00.000Z",
        parts: [
          {
            type: "text",
            id: parsePartId(`part_scrolled_${i}`),
            text: `filler message number ${i}\n\nmore lines here\n\nand even more lines to make this long`,
          },
        ],
      })
    }
    adapter.state.addMessage({
      id: parseMessageId("msg_scrolled_compact"),
      sessionId: SESSION_ID,
      role: "assistant",
      createdAt: "2026-07-08T00:00:00.000Z",
      parts: [{ type: "text", id: parsePartId("part_scrolled_compact"), text: "Compacted" }],
      compactSummary: {
        notification: "Compacted",
        summary: "1. Primary Request and Intent:\n\n- did the first thing\n- did the second thing",
      },
    })

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <box flexGrow={1} minHeight={0} border borderStyle="single" borderColor="#444">
            <Transcript sessionId={SESSION_ID} />
          </box>
        </TestProviders>
      ),
      { width: 80, height: 20 },
    )

    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    const pos = framePosition(frame, "Compaction Summary")
    // The fold must sit on the bottom-most content row for the regression
    // (the row directly above the border's bottom edge).
    expect(frame.split("\n")[pos.y + 1]?.startsWith("└")).toBe(true)
    expect(frame).not.toContain("did the first thing")

    await setup.mockMouse.click(pos.x + 2, pos.y)
    await setup.flush()

    frame = setup.captureCharFrame()
    expect(frame).toContain("did the first thing")
    setup.renderer.destroy()
  })
})

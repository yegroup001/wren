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
import { MessageView, ThinkingPartView } from "./transcript"

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

// Mirrors the Transcript's scrollbox: sticky scrolling is active while the
// user is at the bottom, which is where a freshly completed /compact places
// the summary fold.
function StickyTranscriptScrollbox(props: ParentProps): JSX.Element {
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      paddingRight={1}
      stickyScroll
      stickyStart="bottom"
      focused={false}
      verticalScrollbarOptions={{ visible: true }}
    >
      <box height={1} />
      {props.children}
    </scrollbox>
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

describe("compaction summary fold inside the sticky transcript scrollbox", () => {
  test("clicking expands the fold of a compacted message", async () => {
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "source/model",
      permissionMode: "default",
    })
    adapter.state.addMessage({
      id: parseMessageId("msg_compact_fold"),
      sessionId: SESSION_ID,
      role: "assistant",
      createdAt: "2026-07-08T00:00:00.000Z",
      parts: [
        {
          type: "text",
          id: parsePartId("part_compact_fold"),
          text: "Compacted",
        },
      ],
      compactSummary: {
        notification: "Compacted",
        summary: "1. Primary Request and Intent:\n\n- did the first thing\n- did the second thing",
      },
    })

    const message = adapter.state.store.messages[SESSION_ID]?.[0]
    if (message === undefined) throw new Error("message not added to store")

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <StickyTranscriptScrollbox>
            <MessageView message={message} sessionId={SESSION_ID} isStreaming={false} />
          </StickyTranscriptScrollbox>
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Compaction Summary")
    expect(frame).not.toContain("did the first thing")

    const pos = framePosition(frame, "Compaction Summary")
    await setup.mockMouse.click(pos.x + 2, pos.y)
    await setup.flush()

    frame = setup.captureCharFrame()
    expect(frame).toContain("did the first thing")
    setup.renderer.destroy()
  })

  test("clicking expands the fold of a marker-less summary user message", async () => {
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "source/model",
      permissionMode: "default",
    })
    adapter.state.addMessage({
      id: parseMessageId("msg_compact_plain"),
      sessionId: SESSION_ID,
      role: "user",
      createdAt: "2026-07-08T00:00:00.000Z",
      parts: [
        {
          type: "text",
          id: parsePartId("part_compact_plain"),
          text: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n- did the first thing\n- did the second thing",
        },
      ],
    })

    const message = adapter.state.store.messages[SESSION_ID]?.[0]
    if (message === undefined) throw new Error("message not added to store")

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <StickyTranscriptScrollbox>
            <MessageView message={message} sessionId={SESSION_ID} isStreaming={false} />
          </StickyTranscriptScrollbox>
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Compaction Summary")
    expect(frame).not.toContain("did the first thing")

    const pos = framePosition(frame, "Compaction Summary")
    await setup.mockMouse.click(pos.x + 2, pos.y)
    await setup.flush()

    frame = setup.captureCharFrame()
    expect(frame).toContain("did the first thing")
    setup.renderer.destroy()
  })

  test("clicking expands a completed thought row", async () => {
    const setup = await testRender(
      () => (
        <ThemeProvider>
          <StickyTranscriptScrollbox>
            <ThinkingPartView
              part={{
                type: "thinking",
                id: parsePartId("part_thinking_done"),
                text: "first line of thought\nsecond line of thought",
              }}
              streaming={false}
            />
          </StickyTranscriptScrollbox>
        </ThemeProvider>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("\u25b8 Thought")

    const pos = framePosition(frame, "Thought")
    await setup.mockMouse.click(pos.x + 2, pos.y)
    await setup.flush()

    frame = setup.captureCharFrame()
    expect(frame).toContain("\u25be Thought")
    setup.renderer.destroy()
  })

  test("clicking expands a streaming thinking row", async () => {
    const setup = await testRender(
      () => (
        <ThemeProvider>
          <StickyTranscriptScrollbox>
            <ThinkingPartView
              part={{
                type: "thinking",
                id: parsePartId("part_thinking_stream"),
                text: "first line of thought\nsecond line of thought",
              }}
              streaming={true}
            />
          </StickyTranscriptScrollbox>
        </ThemeProvider>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("\u25b8 Thinking")

    const pos = framePosition(frame, "Thinking")
    await setup.mockMouse.click(pos.x + 2, pos.y)
    await setup.flush()

    frame = setup.captureCharFrame()
    expect(frame).toContain("\u25be Thinking")
    setup.renderer.destroy()
  })

})

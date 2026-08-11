import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { RouteProvider, useRoute } from "../context/route"
import { StoreProvider } from "../context/store"
import { ThemeProvider } from "../context/theme"
import { SubagentPanel } from "./subagent-panel"

const SESSION_ID = parseSessionId("ses_subagent_panel")

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
        <ThemeProvider>{props.children}</ThemeProvider>
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

describe("SubagentPanel", () => {
  test("renders a running subagent duration without an undefined timer callback", async () => {
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "source/model",
      permissionMode: "default",
    })
    adapter.state.addMessage({
      id: parseMessageId("msg_subagent_running"),
      sessionId: SESSION_ID,
      role: "assistant",
      createdAt: new Date(Date.now() - 2000).toISOString(),
      parts: [
        {
          type: "tool_use",
          id: parsePartId("part_subagent_running"),
          toolName: "Agent",
          input: { description: "Inspect model routing", subagent_type: "explore" },
          status: "running",
        },
      ],
    })

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <SubagentPanel sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Inspect model routing")
    setup.renderer.destroy()
  })

  test("opens a completed persisted Agent result using its structured identity", async () => {
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "source/model",
      permissionMode: "default",
    })
    adapter.state.addMessage({
      id: parseMessageId("msg_subagent_completed"),
      sessionId: SESSION_ID,
      role: "assistant",
      createdAt: "2026-07-10T00:00:00.000Z",
      parts: [
        {
          type: "tool_use",
          id: parsePartId("part_subagent_completed"),
          toolName: "Agent",
          input: { description: "Audit persisted output", subagent_type: "Explore" },
          status: "completed",
          agentId: "a0123456789abcdef",
          output: "<persisted-output>\nPreview (first 2.0 KB):\nlarge output\n</persisted-output>",
        },
      ],
    })
    let routeApi: ReturnType<typeof useRoute> | undefined
    const RouteProbe = (): JSX.Element => {
      routeApi = useRoute()
      return <text>route probe</text>
    }

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <RouteProbe />
          <SubagentPanel sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.renderOnce()
    const position = framePosition(setup.captureCharFrame(), "Audit persisted output")
    await setup.mockMouse.click(position.x, position.y)
    await setup.flush()

    expect(routeApi?.route()).toEqual({
      type: "subagent",
      sessionId: SESSION_ID,
      agentId: "a0123456789abcdef",
      description: "Audit persisted output",
      agentStatus: "completed",
    })
    setup.renderer.destroy()
  })
})

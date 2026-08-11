import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import type { Part } from "@wren/protocol"
import { parseMessageId, parsePartId, parsePermissionId, parseSessionId } from "@wren/protocol"
import { createSignal, type JSX, type ParentProps } from "solid-js"
import { DialogModel } from "./src/components/dialog-model"
import { DialogVariants } from "./src/components/dialog-variants"
import { ModalHost, ModalSwitch } from "./src/components/modal-host"
import { PermissionModal } from "./src/components/permission-modal"
import { ToolCallView } from "./src/components/tool-call"
import { Transcript } from "./src/components/transcript"
import { ClipboardProvider } from "./src/context/clipboard"
import { DialogProvider } from "./src/context/dialog"
import { LocalProvider } from "./src/context/local"
import { ModalProvider } from "./src/context/modal"
import { RouteProvider, useRoute } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { KeymapProvider } from "./src/keymap"
import { ToastProvider } from "./src/ui/toast"

const SESSION_ID = parseSessionId("ses_tool_interactions")
const MESSAGE_ID = parseMessageId("msg_tool_interactions")
const PART_ID = parsePartId("part_tool_interactions")

type ToolUsePart = Extract<Part, { type: "tool_use" }>

type CapturedRequest = {
  readonly method: string
  readonly path: string
  readonly body: string
}

function createAdapter(requests: CapturedRequest[] = []): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(request: Request): Promise<Response> {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
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

function framePosition(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(text)
    if (x !== -1) return { x, y }
  }
  throw new Error(`frame text not found: ${text}`)
}

describe("TUI tool interactions", () => {
  test("tool call expands when clicked", async () => {
    const adapter = createAdapter()
    const longOutput = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n")
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <ToolCallView
            part={{
              type: "tool_use",
              id: PART_ID,
              toolName: "Bash",
              input: { command: "printf long" },
              status: "completed",
              output: longOutput,
            }}
          />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )
    await setup.renderOnce()
    const pos = framePosition(setup.captureCharFrame(), "Shell")
    await setup.mockMouse.click(1, pos.y)
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("line 7")
    setup.renderer.destroy()
  })

  test("tool call collapses by default and expands on click", async () => {
    const adapter = createAdapter()
    const [part] = createSignal<ToolUsePart>({
      type: "tool_use",
      id: PART_ID,
      toolName: "Bash",
      input: { command: "echo test" },
      status: "completed",
      output: "result_line_1\nresult_line_2",
    })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <ToolCallView part={part()} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.renderOnce()
    const collapsedFrame = setup.captureCharFrame()
    expect(collapsedFrame).toContain("Shell")
    expect(collapsedFrame).not.toContain("result_line_1")

    const pos = framePosition(collapsedFrame, "Shell")
    await setup.mockMouse.click(1, pos.y)
    await setup.flush()
    const expandedFrame = setup.captureCharFrame()
    expect(expandedFrame).toContain("result_line_1")
    setup.renderer.destroy()
  })

  test("expanded Edit tool shows old and new strings instead of only the result", async () => {
    const adapter = createAdapter()
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <ToolCallView
            part={{
              type: "tool_use",
              id: PART_ID,
              toolName: "Edit",
              input: {
                file_path: "/tmp/demo.ts",
                old_string: "const a = 1",
                new_string: "const a = 2",
              },
              status: "completed",
              output: "The file /tmp/demo.ts has been updated successfully.",
            }}
          />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.renderOnce()
    const collapsedFrame = setup.captureCharFrame()
    const pos = framePosition(collapsedFrame, "Edit")
    await setup.mockMouse.click(1, pos.y)
    await setup.flush()
    const expandedFrame = setup.captureCharFrame()
    expect(expandedFrame).toContain("const a = 1")
    expect(expandedFrame).toContain("const a = 2")
    setup.renderer.destroy()
  })

  test("completed persisted Agent tool opens its structured subagent route", async () => {
    const adapter = createAdapter()
    let routeApi: ReturnType<typeof useRoute> | undefined
    const RouteProbe = (): JSX.Element => {
      routeApi = useRoute()
      return <text>route probe</text>
    }
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <RouteProbe />
          <ToolCallView
            sessionId={SESSION_ID}
            part={{
              type: "tool_use",
              id: PART_ID,
              toolName: "Agent",
              input: { description: "Inspect persisted result", subagent_type: "Explore" },
              status: "completed",
              agentId: "a0123456789abcdef",
              output:
                "<persisted-output>\nPreview (first 2.0 KB):\nlarge output\n</persisted-output>",
            }}
          />
        </TestProviders>
      ),
      { width: 80, height: 16 },
    )

    await setup.renderOnce()
    const agentPosition = framePosition(setup.captureCharFrame(), "Agent")
    await setup.mockMouse.click(agentPosition.x, agentPosition.y)
    await setup.flush()
    const linkPosition = framePosition(setup.captureCharFrame(), "View subagent transcript")
    await setup.mockMouse.click(linkPosition.x, linkPosition.y)
    await setup.flush()

    expect(routeApi?.route()).toEqual({
      type: "subagent",
      sessionId: SESSION_ID,
      agentId: "a0123456789abcdef",
      description: "Inspect persisted result",
      agentStatus: "completed",
    })
    setup.renderer.destroy()
  })

  test("variants selector lists all effort levels", async () => {
    const adapter = createAdapter()
    const [visible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogVariants sessionId={SESSION_ID} visible={visible} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 16 },
    )

    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Thinking effort")
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(frame).toContain(effort)
    }
    setup.renderer.destroy()
  })

  test("variants selector applies effort through the adapter", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createAdapter(requests)
    const [visible, setVisible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogVariants
            sessionId={SESSION_ID}
            visible={visible}
            onClose={() => setVisible(false)}
          />
        </TestProviders>
      ),
      { width: 80, height: 16 },
    )

    await setup.renderOnce()
    const pos = framePosition(setup.captureCharFrame(), "high")
    await setup.mockMouse.click(pos.x, pos.y)
    await setup.flush()

    expect(requests).toEqual([
      {
        method: "POST",
        path: `/session/${SESSION_ID}/effort`,
        body: JSON.stringify({ effort: "high" }),
      },
    ])
    expect(setup.captureCharFrame()).not.toContain("Thinking effort")
    setup.renderer.destroy()
  })

  test("model selector lists glm-5.2", async () => {
    const adapter = createAdapter()
    const [visible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogModel visible={visible} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 16 },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("GLM-5.2")
    setup.renderer.destroy()
  })

  test("model selector keeps dialog open and shows failure feedback on rejected change", async () => {
    const adapter: WrenAdapter = {
      state: createTuiStore(),
      async fetch(): Promise<Response> {
        return new Response("bad model", { status: 500, statusText: "Server Error" })
      },
      async resume(): Promise<void> {},
      async waitForIdle(): Promise<void> {},
    }
    const [visible, setVisible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogModel sessionId={SESSION_ID} visible={visible} onClose={() => setVisible(false)} />
        </TestProviders>
      ),
      { width: 80, height: 16 },
    )

    await setup.renderOnce()
    const pos = framePosition(setup.captureCharFrame(), "GLM-5.2")
    await setup.mockMouse.click(pos.x, pos.y)
    await setup.flush()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Select model")
    expect(frame).toContain("failed")
    setup.renderer.destroy()
  })

  test("permission options are clickable", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setPermission({
      id: parsePermissionId("perm_tool_interactions"),
      sessionId: SESSION_ID,
      toolName: "Bash",
      input: { command: "ls -la" },
      displayType: "bash",
    })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <PermissionModal sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )
    await setup.renderOnce()
    const pos = framePosition(setup.captureCharFrame(), "Reject")
    await setup.mockMouse.click(pos.x, pos.y)
    await setup.flush()
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/session/${SESSION_ID}/permission/perm_tool_interactions`,
        body: JSON.stringify({ response: "deny" }),
      },
    ])
    setup.renderer.destroy()
  })

  test("modal activation closes an open user-message action menu", async () => {
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "user",
      parts: [{ type: "text", id: PART_ID, text: "Review this change" }],
      createdAt: "2026-07-10T00:00:00.000Z",
    })
    const [modalActive, setModalActive] = createSignal(false)
    let editedMessage: string | undefined
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Transcript
            sessionId={SESSION_ID}
            modalActive={modalActive}
            onEditMessage={(text) => {
              editedMessage = text
            }}
          />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )
    await setup.renderOnce()
    const pos = framePosition(setup.captureCharFrame(), "You")
    await setup.mockMouse.click(pos.x, pos.y)
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("Edit & resend")

    setModalActive(true)
    await setup.flush()
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(setup.captureCharFrame()).not.toContain("Edit & resend")
    expect(editedMessage).toBeUndefined()
    setup.renderer.destroy()
  })

  test("modal activation prevents opening a user-message action menu", async () => {
    const adapter = createAdapter()
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "user",
      parts: [{ type: "text", id: PART_ID, text: "Review this change" }],
      createdAt: "2026-07-10T00:00:00.000Z",
    })
    const [modalActive] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Transcript sessionId={SESSION_ID} modalActive={modalActive} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )
    await setup.renderOnce()
    const pos = framePosition(setup.captureCharFrame(), "You")
    await setup.mockMouse.click(pos.x, pos.y)
    await setup.flush()

    expect(setup.captureCharFrame()).not.toContain("Edit & resend")
    setup.renderer.destroy()
  })
})

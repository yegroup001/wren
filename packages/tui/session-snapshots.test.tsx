import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import {
  type Diff,
  type PermissionRequest,
  parseMessageId,
  parsePartId,
  parsePermissionId,
  parseSessionId,
  type Session as SessionMeta,
  type Todo,
} from "@wren/protocol"
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
import { KeymapProvider } from "./src/keymap"
import { Home } from "./src/routes/home"
import { Session } from "./src/routes/session"
import { ToastProvider } from "./src/ui/toast"

const SESSION_ID = parseSessionId("ses_snap")
const MESSAGE_ID = parseMessageId("msg_snap")
const USER_MESSAGE_ID = parseMessageId("msg_user_snap")
const PART_ID = parsePartId("part_snap")
const HISTORY_MESSAGE_ID = parseMessageId("msg_history_snap")
const HISTORY_PART_ID = parsePartId("part_history_snap")

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

function createSession(): SessionMeta {
  return {
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "claude-sonnet-4-5",
    permissionMode: "default",
  }
}

function setupIdleSession(adapter: WrenAdapter): void {
  const session = createSession()
  adapter.state.addSession(session)
  adapter.state.setStatus(SESSION_ID, { type: "idle" })
}

function TestProviders(
  props: ParentProps<{
    adapter: WrenAdapter
    initialRoute: Route
  }>,
): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute}>
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

type SessionRenderOptions = {
  readonly width?: number
  readonly height?: number
}

async function renderSession(adapter: WrenAdapter, options: SessionRenderOptions = {}) {
  const setup = await testRender(
    () => (
      <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
        <Session sessionId={SESSION_ID} />
      </TestProviders>
    ),
    { width: options.width ?? 80, height: options.height ?? 24 },
  )
  await setup.renderOnce()
  return setup
}

describe("Wren TUI session snapshots", () => {
  test("home route renders logo and prompt", async () => {
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
    setup.renderer.destroy()
  })

  test("home route renders a restored session preview", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.setPreview(SESSION_ID, {
      createdAt: "2026-07-08T00:00:00.000Z",
      text: "Identify this historical session",
    })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }}>
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    expect(setup.captureCharFrame()).toContain("Identify this historical session")
    setup.renderer.destroy()
  })

  test("unloaded transcript fetches despite a session preview", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.setPreview(SESSION_ID, {
      createdAt: "2026-07-08T00:00:00.000Z",
      text: "Identify this historical session",
    })
    const requested: string[] = []
    adapter.fetch = async (request): Promise<Response> => {
      requested.push(request.url)
      if (request.url === `http://wren.internal/session/${SESSION_ID}/messages`) {
        adapter.state.addMessage({
          id: HISTORY_MESSAGE_ID,
          sessionId: SESSION_ID,
          role: "assistant",
          parts: [{ type: "text", id: HISTORY_PART_ID, text: "Loaded historical assistant reply" }],
          createdAt: "2026-07-08T00:01:00.000Z",
        })
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }

    const setup = await renderSession(adapter)
    await setup.flush()

    expect(requested).toEqual([`http://wren.internal/session/${SESSION_ID}/messages`])
    expect(setup.captureCharFrame()).toContain("Loaded historical assistant reply")
    setup.renderer.destroy()
  })
  test("idle session shows transcript and prompt", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "text", id: PART_ID, text: "Hello from Wren" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Hello from Wren")
    expect(frame).toContain("idle")
    setup.renderer.destroy()
  })

  test("large transcript renders only the latest message window", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.hydrateSessionMessages(
      SESSION_ID,
      Array.from({ length: 5000 }, (_, index) => ({
        id: parseMessageId(`msg_large_snapshot_${index}`),
        sessionId: SESSION_ID,
        role: "assistant" as const,
        parts: [
          {
            type: "text" as const,
            id: parsePartId(`part_large_snapshot_${index}`),
            text: `history marker ${index}`,
          },
        ],
        createdAt: "2026-07-08T00:00:00.000Z",
      })),
    )

    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()

    expect(frame).toContain("history marker 4999")
    expect(frame).not.toContain("history marker 0")
    setup.renderer.destroy()
  })

  test("selecting Edit & resend stages the draft text in the prompt", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: USER_MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "user",
      parts: [{ type: "text", id: PART_ID, text: "Original user prompt" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter)
    const initialFrame = setup.captureCharFrame()
    const youRow = initialFrame.split("\n").findIndex((line) => line.includes("You"))
    expect(youRow).toBeGreaterThanOrEqual(0)

    await setup.mockMouse.click(3, youRow)
    await setup.flush()
    setup.mockInput.pressEnter()
    await setup.flush()

    const stagedFrame = setup.captureCharFrame()
    expect(stagedFrame).toContain("Original user prompt")
    setup.renderer.destroy()
  })

  test("streaming assistant text shows partial response", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "text", id: PART_ID, text: "Partial stream" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    adapter.state.appendPartText(SESSION_ID, MESSAGE_ID, PART_ID, " delta")
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Partial stream delta")
    setup.renderer.destroy()
  })

  test("pending permission shows modal", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const perm: PermissionRequest = {
      id: parsePermissionId("perm_snap"),
      sessionId: SESSION_ID,
      toolName: "Bash",
      input: { command: "ls -la" },
      displayType: "bash",
    }
    adapter.state.setPermission(perm)
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Permission")
    expect(frame).toContain("Bash")
    expect(frame).toContain("Allow")
    expect(frame).toContain("Reject")
    setup.renderer.destroy()
  })

  test("narrow permission modal keeps all controls readable", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.setPermission({
      id: parsePermissionId("perm_narrow"),
      sessionId: SESSION_ID,
      toolName: "Bash",
      input: { command: "pwd" },
      displayType: "bash",
    })

    const setup = await renderSession(adapter, { width: 40, height: 24 })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Allow always")
    expect(frame).toContain("Reject")
    expect(frame).toContain("select")
    expect(frame).toContain("enter confirm")
    expect(frame).toContain("esc keeps open")
    setup.renderer.destroy()
  })

  test("completed tool call shows tool display", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [
        {
          type: "tool_use",
          id: PART_ID,
          toolName: "Bash",
          input: { command: "echo hello" },
          status: "completed",
          output: "hello",
        },
      ],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("echo hello")
    expect(frame).toContain("hello")
    setup.renderer.destroy()
  })

  test("long tool output is collapsed until clicked", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const longOutput = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n")
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [
        {
          type: "tool_use",
          id: PART_ID,
          toolName: "Bash",
          input: { command: "printf long" },
          status: "completed",
          output: longOutput,
        },
      ],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Shell")
    expect(frame).toContain("24 lines")
    expect(frame).not.toContain("line 24")
    setup.renderer.destroy()
  })

  test("todo list shows todos with status markers", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const todos: Todo[] = [
      { id: "t1", sessionId: SESSION_ID, status: "completed", content: "Read package.json" },
      { id: "t2", sessionId: SESSION_ID, status: "in_progress", content: "Write tests" },
      { id: "t3", sessionId: SESSION_ID, status: "pending", content: "Refactor code" },
    ]
    adapter.state.setTodos(SESSION_ID, todos)
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("TODO")
    expect(frame).toContain("Read package.json")
    expect(frame).toContain("Write tests")
    expect(frame).toContain("Refactor code")
    setup.renderer.destroy()
  })

  test("diff panel shows file changes", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const diff: Diff = {
      sessionId: SESSION_ID,
      files: [
        { path: "src/index.ts", added: 12, removed: 3 },
        { path: "src/utils.ts", added: 5, removed: 0 },
      ],
      updatedAt: "2026-07-08T00:00:00.000Z",
    }
    adapter.state.setDiff(diff)
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("CHANGES")
    expect(frame).toContain("src/index.ts")
    expect(frame).toContain("src/utils.ts")
    setup.renderer.destroy()
  })

  test("subagent panel shows running and completed agents", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [
        {
          type: "tool_use",
          id: PART_ID,
          toolName: "Agent",
          input: { description: "Search codebase", subagent_type: "general-purpose" },
          status: "completed",
          output: [
            { type: "text", text: "Found 3 files matching the pattern." },
            {
              type: "text",
              text: "agentId: a1b2c3d4e5f6g7h8\n<usage>total_tokens: 100\ntool_uses: 3\nduration_ms: 4500</usage>",
            },
          ],
        },
      ],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("SUBAGENT")
    expect(frame).toContain("general-purpose")
    expect(frame).toContain("Search codebase")
    expect(frame).toContain("4s")
    setup.renderer.destroy()
  })

  test("narrow terminal (40 cols) renders without crashing", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "text", id: PART_ID, text: "Short text" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter, { width: 40, height: 12 })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Short text")
    setup.renderer.destroy()
  })

  test("TUI hides unsupported cloud surfaces in session", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("session.share")
    expect(frame).not.toContain("console.org")
    expect(frame).not.toContain("provider.connect")
    expect(frame).not.toContain("backgroundSubagents")
    expect(frame).not.toContain("upgrade")
    setup.renderer.destroy()
  })

  test("session sidebar stays hidden below 60 columns", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)

    const setup = await renderSession(adapter, { width: 59 })
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("TODO")
    expect(frame).not.toContain("SUBAGENT")
    expect(frame).not.toContain("CHANGES")
    setup.renderer.destroy()
  })

  test("empty session sidebar shows all section headings and separators at 60 columns", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)

    const setup = await renderSession(adapter, { width: 60 })
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const todoRow = lines.findIndex((line) => line.includes("TODO"))
    const subagentRow = lines.findIndex((line) => line.includes("SUBAGENT"))
    const changesRow = lines.findIndex((line) => line.includes("CHANGES"))

    expect(todoRow).toBeGreaterThanOrEqual(0)
    expect(subagentRow).toBeGreaterThan(todoRow)
    expect(changesRow).toBeGreaterThan(subagentRow)
    expect(lines[subagentRow - 1]).toContain("─")
    expect(lines[changesRow - 1]).toContain("─")
    setup.renderer.destroy()
  })

  test("populated sidebar bodies do not duplicate section headings", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.setTodos(SESSION_ID, [
      { id: "t1", sessionId: SESSION_ID, status: "in_progress", content: "Implement sidebar" },
    ])
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "text", id: PART_ID, text: "Keep the sidebar full height" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    adapter.state.setDiff({
      sessionId: SESSION_ID,
      files: [{ path: "src/sidebar.tsx", added: 8, removed: 2 }],
      updatedAt: "2026-07-08T00:00:00.000Z",
    })

    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect({
      todo: frame.match(/\bTODO\b/g)?.length ?? 0,
      subagent: frame.match(/\bSUBAGENT\b/g)?.length ?? 0,
      changes: frame.match(/\bCHANGES\b/g)?.length ?? 0,
    }).toEqual({ todo: 1, subagent: 1, changes: 1 })
    expect(frame).toContain("Implement sidebar")
    expect(frame).toContain("src/sidebar.tsx")
    setup.renderer.destroy()
  })
})

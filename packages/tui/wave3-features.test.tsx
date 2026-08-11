import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import {
  type Diff,
  type PermissionRequest,
  parseMessageId,
  parsePartId,
  parseSessionId,
  type QuestionRequest,
  type Session as SessionMeta,
} from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { createSignal, Match, Switch } from "solid-js"
import { type CommandAction, CommandPalette } from "./src/components/command-palette"
import { DialogModel } from "./src/components/dialog-model"
import { DialogSessionList } from "./src/components/dialog-session-list"
import {
  allExpandedDirectories,
  buildFileTree,
  flattenFileTree,
} from "./src/components/diff-viewer-utils"
import { fuzzyMatch, fuzzyScore } from "./src/components/fuzzy"
import { ModalHost, ModalSwitch } from "./src/components/modal-host"
import { ClipboardProvider } from "./src/context/clipboard"
import { DialogProvider } from "./src/context/dialog"
import { LocalProvider } from "./src/context/local"
import { ModalProvider } from "./src/context/modal"
import type { Route } from "./src/context/route"
import { RouteProvider } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { DEFAULT_BINDINGS, KeymapProvider } from "./src/keymap"
import { Home } from "./src/routes/home"
import { Session } from "./src/routes/session"
import { ToastProvider } from "./src/ui/toast"

const SESSION_ID = parseSessionId("ses_wave3")
const MESSAGE_ID = parseMessageId("msg_wave3")
const PART_ID = parsePartId("part_wave3")

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

function createSession(): SessionMeta {
  return {
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "claude-sonnet-4-5",
    permissionMode: "default",
  }
}

function setupIdleSession(adapter: WrenAdapter): void {
  adapter.state.addSession(createSession())
  adapter.state.setStatus(SESSION_ID, { type: "idle" })
}

function TestProviders(
  props: ParentProps<{ adapter: WrenAdapter; initialRoute?: Route }>,
): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute ?? { type: "home" }}>
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

async function renderSession(adapter: WrenAdapter, width = 80, height = 24) {
  const setup = await testRender(
    () => (
      <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
        <Session sessionId={SESSION_ID} />
      </TestProviders>
    ),
    { width, height },
  )
  await setup.renderOnce()
  return setup
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wave 3: Diff viewer", () => {
  test("diff viewer renders with file changes", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const diff: Diff = {
      sessionId: SESSION_ID,
      files: [
        { path: "src/index.ts", added: 10, removed: 3 },
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

  test("buildFileTree produces correct tree structure", () => {
    const files = [
      { path: "src/a.ts", added: 1, removed: 0 },
      { path: "src/b.ts", added: 0, removed: 1 },
      { path: "test/c.ts", added: 2, removed: 0 },
    ]
    const tree = buildFileTree(files)
    expect(tree.length).toBe(2) // src, test
    const expanded = allExpandedDirectories(tree)
    const rows = flattenFileTree(tree, expanded)
    expect(rows.length).toBe(5) // src, a.ts, b.ts, test, c.ts
  })

  test("flattenFileTree respects expanded nodes", () => {
    const files = [
      { path: "dir1/file1.ts", added: 1, removed: 0 },
      { path: "dir1/file2.ts", added: 0, removed: 1 },
      { path: "dir2/file3.ts", added: 2, removed: 0 },
    ]
    const tree = buildFileTree(files)
    const collapsed = flattenFileTree(tree, new Set())
    expect(collapsed.length).toBe(2) // dir1, dir2 (collapsed)
    const expanded = allExpandedDirectories(tree)
    const allRows = flattenFileTree(tree, expanded)
    expect(allRows.length).toBe(5) // dir1, file1, file2, dir2, file3
  })
})

describe("Wave 3: Model selector dialog", () => {
  test("model selector shows available models", async () => {
    const adapter = createMockAdapter()
    const [visible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogModel visible={() => visible()} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Select model")
    expect(frame).toContain("GLM-5.2")
    setup.renderer.destroy()
  })
})

describe("Wave 3: Session list dialog", () => {
  test("session list shows sessions", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "user",
      parts: [{ type: "text", id: PART_ID, text: "Hello world" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const [visible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogSessionList visible={() => visible()} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Sessions")
    expect(frame).toContain("claude-sonnet-4-5")
    expect(frame).toContain("d delete")
    setup.renderer.destroy()
  })

  test("session list shows empty state", async () => {
    const adapter = createMockAdapter()
    const [visible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogSessionList visible={() => visible()} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("No sessions")
    setup.renderer.destroy()
  })

  test("session list keeps a selectable row after deleting the final selection", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addSession({
      id: parseSessionId("ses_wave3_second"),
      cwd: "/tmp/second-project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    const [visible, setVisible] = createSignal(true)
    let closeCount = 0
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <DialogSessionList
            visible={visible}
            onClose={() => {
              closeCount += 1
              setVisible(false)
            }}
          />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("d")
    await setup.flush()
    setup.mockInput.pressKey("d")
    await setup.flush()
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(closeCount).toBe(1)
    setup.renderer.destroy()
  })
})

describe("Wave 3: Question modal", () => {
  test("question modal renders question and input", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const question: QuestionRequest = {
      id: "req_q1" as QuestionRequest["id"],
      sessionId: SESSION_ID,
      title: "Which approach?",
      detail: "Choose how to proceed",
      options: [
        { id: "opt1", label: "Option A" },
        { id: "opt2", label: "Option B" },
      ],
    }
    adapter.state.setQuestion(question)

    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Which approach?")
    expect(frame).toContain("Option A")
    expect(frame).toContain("Option B")
    setup.renderer.destroy()
  })

  test("permission modal takes precedence over a pending question", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.setQuestion({
      id: "req_q2" as QuestionRequest["id"],
      sessionId: SESSION_ID,
      title: "Which approach?",
      detail: "Choose how to proceed",
      options: [{ id: "opt1", label: "Option A" }],
    })
    adapter.state.setPermission({
      id: "perm_q2" as PermissionRequest["id"],
      sessionId: SESSION_ID,
      toolName: "Bash",
      input: { command: "pwd" },
      displayType: "bash",
    })

    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Permission required")
    expect(frame).not.toContain("Which approach?")
    setup.renderer.destroy()
  })
})

describe("Wave 3: Command palette", () => {
  test("command palette renders commands", async () => {
    const adapter = createMockAdapter()
    const actions: CommandAction[] = [
      {
        id: "test1",
        title: "Toggle diff viewer",
        description: "View changes",
        keybinding: "<leader>d",
        category: "View",
        run: () => {},
      },
      {
        id: "test2",
        title: "Select model",
        description: "Choose model",
        keybinding: "<leader>m",
        category: "Model",
        run: () => {},
      },
    ]
    const [visible] = createSignal(true)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <CommandPalette visible={() => visible()} onClose={() => {}} actions={() => actions} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Toggle diff viewer")
    expect(frame).toContain("Select model")
    setup.renderer.destroy()
  })
})

describe("Wave 3: Fuzzy matching", () => {
  test("fuzzyMatch matches substrings in order", () => {
    expect(fuzzyMatch("abc", "aXXbXXc")).toBe(true)
    expect(fuzzyMatch("abc", "cba")).toBe(false)
    expect(fuzzyMatch("", "anything")).toBe(true)
    expect(fuzzyMatch("xyz", "abc")).toBe(false)
  })

  test("fuzzyScore returns lower score for closer matches", () => {
    expect(fuzzyScore("abc", "abc")).toBeLessThanOrEqual(fuzzyScore("abc", "aXbXc"))
    expect(fuzzyScore("xyz", "abc")).toBe(-1)
  })
})

describe("Wave 3: Keymap bindings", () => {
  test("default bindings include wave 3 commands", () => {
    const commands = DEFAULT_BINDINGS.map((b) => b.command)
    expect(commands).toContain("diff.toggle")
    expect(commands).toContain("model.list")
    expect(commands).toContain("session.list")
    expect(commands).toContain("command.palette")
    expect(commands).toContain("command.palette_colon")
  })
})

describe("Wave 3: Existing tests still pass", () => {
  test("home route still renders", async () => {
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
    setup.renderer.destroy()
  })

  test("session route still renders with transcript", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    adapter.state.addMessage({
      id: MESSAGE_ID,
      sessionId: SESSION_ID,
      role: "assistant",
      parts: [{ type: "text", id: PART_ID, text: "Hello from Wave 3" }],
      createdAt: "2026-07-08T00:00:00.000Z",
    })
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Hello from Wave 3")
    expect(frame).toContain("idle")
    setup.renderer.destroy()
  })

  test("TUI still hides unsupported surfaces", async () => {
    const adapter = createMockAdapter()
    setupIdleSession(adapter)
    const setup = await renderSession(adapter)
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("session.share")
    expect(frame).not.toContain("console.org")
    expect(frame).not.toContain("upgrade")
    setup.renderer.destroy()
  })
})

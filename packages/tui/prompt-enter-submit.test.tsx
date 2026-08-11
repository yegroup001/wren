import { describe, expect, test } from "bun:test"
import type { TextareaOptions } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { createSignal } from "solid-js"
import { DialogModel } from "./src/components/dialog-model"
import { ModalSwitch } from "./src/components/modal-host"
import { Prompt } from "./src/components/prompt"
import { ClipboardProvider } from "./src/context/clipboard"
import { DialogProvider } from "./src/context/dialog"
import { LocalProvider } from "./src/context/local"
import { ModalProvider, useModal } from "./src/context/modal"
import type { Route } from "./src/context/route"
import { RouteProvider } from "./src/context/route"
import { StoreProvider } from "./src/context/store"
import { ThemeProvider } from "./src/context/theme"
import { KeymapProvider } from "./src/keymap"
import { Home } from "./src/routes/home"
import { Session } from "./src/routes/session"
import { Toast, ToastProvider } from "./src/ui/toast"

const SESSION_ID = parseSessionId("ses_prompt_enter")

type TextareaKeyBinding = NonNullable<TextareaOptions["keyBindings"]>[number]

type CapturedRequest = {
  readonly method: string
  readonly path: string
  readonly body: string
}

type PromptKeybindingsModule = {
  readonly promptTextareaKeyBindings: readonly TextareaKeyBinding[]
}

function createCapturingAdapter(requests: CapturedRequest[]): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const body = await request.text()
      requests.push({ method: request.method, path, body })
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function createHomeAdapter(requests: CapturedRequest[]): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const body = await request.text()
      requests.push({ method: request.method, path, body })
      if (path === "/session" && request.method === "POST") {
        return new Response(JSON.stringify({ id: SESSION_ID }), {
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
}

function createFailingModelAdapter(requests: CapturedRequest[]): WrenAdapter {
  return {
    state: createTuiStore(),
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const body = await request.text()
      requests.push({ method: request.method, path, body })
      if (path === `/session/${SESSION_ID}/model`) {
        return new Response("bad model", { status: 500, statusText: "Server Error" })
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(
  props: ParentProps<{ adapter: WrenAdapter; initialRoute: Route; initialModel?: string }>,
): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute}>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider initialModel={props.initialModel}>
            <ClipboardProvider>
              <DialogProvider>
                <ToastProvider>
                  <KeymapProvider>
                    <ModalProvider>
                      <ModalSwitch>
                        {props.children}
                        <Toast />
                      </ModalSwitch>
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

type BindingModifiers = {
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
}

function findBinding(
  bindings: readonly TextareaKeyBinding[],
  name: string,
  modifiers: BindingModifiers = {},
): TextareaKeyBinding | undefined {
  return bindings.find(
    (binding) =>
      binding.name === name &&
      Boolean(binding.ctrl) === Boolean(modifiers.ctrl) &&
      Boolean(binding.shift) === Boolean(modifiers.shift) &&
      Boolean(binding.meta) === Boolean(modifiers.meta),
  )
}

describe("Wren TUI prompt Enter submit", () => {
  test("maps plain Enter to submit and Shift+Enter to newline", async () => {
    // Given: the prompt textarea exports explicit key bindings for OpenTUI.
    const modulePath = "./src/components/prompt-keybindings"
    const module: PromptKeybindingsModule = await import(modulePath)

    // When: the bindings are inspected directly.
    const enter = findBinding(module.promptTextareaKeyBindings, "return")
    const keypadEnter = findBinding(module.promptTextareaKeyBindings, "kpenter")
    const shiftEnter = findBinding(module.promptTextareaKeyBindings, "return", { shift: true })
    const shiftKeypadEnter = findBinding(module.promptTextareaKeyBindings, "kpenter", {
      shift: true,
    })
    const ctrlEnter = findBinding(module.promptTextareaKeyBindings, "return", { ctrl: true })
    const ctrlKeypadEnter = findBinding(module.promptTextareaKeyBindings, "kpenter", { ctrl: true })
    const altEnter = findBinding(module.promptTextareaKeyBindings, "return", { meta: true })
    const altKeypadEnter = findBinding(module.promptTextareaKeyBindings, "kpenter", { meta: true })
    const ctrlJ = findBinding(module.promptTextareaKeyBindings, "j", { ctrl: true })

    // Then: Enter submits and every advertised newline shortcut inserts a newline.
    expect(enter?.action).toBe("submit")
    expect(keypadEnter?.action).toBe("submit")
    expect(shiftEnter?.action).toBe("newline")
    expect(shiftKeypadEnter?.action).toBe("newline")
    expect(ctrlEnter?.action).toBe("newline")
    expect(ctrlKeypadEnter?.action).toBe("newline")
    expect(altEnter?.action).toBe("newline")
    expect(altKeypadEnter?.action).toBe("newline")
    expect(ctrlJ?.action).toBe("newline")
  })

  test("submits rendered prompt text when plain Enter is pressed", async () => {
    // Given: an idle session prompt rendered through the real OpenTUI test renderer.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    // When: a user types a prompt and presses plain Enter.
    await setup.mockInput.typeText("explain the diff")
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the prompt is submitted once through the adapter message endpoint.
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/session/${SESSION_ID}/message`,
        body: JSON.stringify({ prompt: "explain the diff" }),
      },
    ])
    setup.renderer.destroy()
  })

  test("home prompt creates a session and submits text when Enter is pressed", async () => {
    // Given: the Home route is rendered with the real OpenTUI test renderer.
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    // When: a user types into the first-screen prompt and presses plain Enter.
    await setup.mockInput.typeText("hello from home")
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: Home creates a session and sends the prompt to that session.
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/session",
        body: JSON.stringify({
          cwd: process.cwd(),
          modelId: "glm-5.2",
          permissionMode: "auto",
          effort: "default",
        }),
      },
      {
        method: "POST",
        path: `/session/${SESSION_ID}/message`,
        body: JSON.stringify({ prompt: "hello from home" }),
      },
    ])
    setup.renderer.destroy()
  })

  test("Home Tab selects the current slash-command completion", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("/mod")
    setup.mockInput.pressTab()
    await setup.flush()

    expect(requests).toEqual([])
    expect(setup.captureCharFrame()).toContain("/mode")
    setup.renderer.destroy()
  })

  test("Home Tab cycles permission mode while the prompt editor is focused", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("ordinary text")
    setup.mockInput.pressTab()
    await setup.flush()

    expect(requests).toEqual([])
    expect(setup.captureCharFrame()).toContain("perm: edits")
    setup.renderer.destroy()
  })

  test("Session Tab cycles permission mode when no editor is focused", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Session sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    await setup.flush()
    const focused = setup.renderer.currentFocusedRenderable
    if (focused !== null) setup.renderer.blurRenderable(focused)
    setup.mockInput.pressTab()
    await setup.flush()

    expect(requests).toContainEqual({
      method: "POST",
      path: `/session/${SESSION_ID}/permission-mode`,
      body: JSON.stringify({ permissionMode: "plan" }),
    })
    setup.renderer.destroy()
  })

  test("home prompt creates an auto-permission session when launched in auto mode", async () => {
    // Given: the Home route is rendered after the CLI was launched with --auto.
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const originalArgv = process.argv
    process.argv = [...originalArgv, "--auto"]
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    try {
      setup = await testRender(
        () => (
          <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
            <Home />
          </TestProviders>
        ),
        { width: 80, height: 24 },
      )

      // When: a user types into the first-screen prompt and presses plain Enter.
      await setup.mockInput.typeText("hello with auto")
      setup.mockInput.pressEnter()
      await setup.flush()

      // Then: Home creates the new session in auto permission mode.
      expect(requests[0]).toEqual({
        method: "POST",
        path: "/session",
        body: JSON.stringify({
          cwd: process.cwd(),
          modelId: "glm-5.2",
          permissionMode: "auto",
          effort: "default",
        }),
      })
    } finally {
      process.argv = originalArgv
      setup?.renderer.destroy()
    }
  })

  test("Home mode and variants commands update the next-session defaults", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("/mode")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(requests).toEqual([])

    await setup.mockInput.typeText("/variants high")
    setup.mockInput.pressEnter()
    await setup.flush()
    expect(requests).toEqual([])

    await setup.mockInput.typeText("create a session")
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests[0]).toEqual({
      method: "POST",
      path: "/session",
      body: JSON.stringify({
        cwd: process.cwd(),
        modelId: "glm-5.2",
        permissionMode: "acceptEdits",
        effort: "high",
      }),
    })
    setup.renderer.destroy()
  })

  test("session /variants dialog applies the selected effort through the adapter", async () => {
    // Given: an idle session rendered through the real Session route.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Session sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    // When: the user opens the thinking-effort dialog and clicks a level.
    await setup.mockInput.typeText("/variants")
    setup.mockInput.pressEnter()
    await setup.flush()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Thinking effort")
    const effortLabel = ["low", "medium", "high", "xhigh", "max"].find((level) =>
      frame.includes(level),
    )
    expect(effortLabel).toBeDefined()
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes(effortLabel as string))
    expect(y).toBeGreaterThan(-1)
    const x = lines[y].indexOf(effortLabel as string)
    await setup.mockMouse.click(x, y)
    await setup.flush()

    // Then: the selected effort is posted to the session effort endpoint.
    expect(requests).toContainEqual({
      method: "POST",
      path: `/session/${SESSION_ID}/effort`,
      body: JSON.stringify({ effort: effortLabel }),
    })
    setup.renderer.destroy()
  })

  test("slash model command updates the session model instead of sending a prompt", async () => {
    // Given: an idle session prompt rendered through the real OpenTUI test renderer.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    // When: the user enters an explicit model command.
    await setup.mockInput.typeText("/models anthropic/claude-opus-4-5")
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the TUI updates the session model and does not send the command to the LLM.
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/session/${SESSION_ID}/model`,
        body: JSON.stringify({ modelId: "anthropic/claude-opus-4-5" }),
      },
    ])
    setup.renderer.destroy()
  })

  function ModelPromptProbe(props: { sessionId: string }): JSX.Element {
    const modal = useModal()
    return (
      <Prompt
        sessionId={props.sessionId}
        onOpenModelDialog={() =>
          modal.open(() => (
            <DialogModel sessionId={props.sessionId} visible={() => true} onClose={modal.close} />
          ))
        }
      />
    )
  }

  test("exact model command opens the selector on first Enter", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <ModelPromptProbe sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("/models")
    setup.mockInput.pressEnter()
    await setup.flush()
    await setup.renderOnce()

    expect(requests).toEqual([])
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Select model")
    setup.renderer.destroy()
  })

  test("exact mode command runs before autocomplete selection", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.mockInput.typeText("/mode")
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([
      {
        method: "POST",
        path: `/session/${SESSION_ID}/permission-mode`,
        body: JSON.stringify({ permissionMode: "plan" }),
      },
    ])
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("Select model")
    setup.renderer.destroy()
  })

  test("partial model command keeps autocomplete behavior", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <ModelPromptProbe sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.mockInput.typeText("/mod")
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([])
    expect(setup.captureCharFrame()).toContain("Select model")
    setup.renderer.destroy()
  })

  test("slash model command shows feedback when the model change fails", async () => {
    // Given: an idle session prompt backed by a model endpoint that rejects the change.
    const requests: CapturedRequest[] = []
    const adapter = createFailingModelAdapter(requests)
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    // When: the user enters a model command with a non-existent model.
    await setup.mockInput.typeText("/models nonexistent/missing-model")
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the command is not sent to the LLM and visible failure feedback is rendered.
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/session/${SESSION_ID}/model`,
        body: JSON.stringify({ modelId: "nonexistent/missing-model" }),
      },
    ])
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Model change failed")
    expect(frame).toContain("missing-model")
    setup.renderer.destroy()
  })

  test("renders prompt shell hints and model row", async () => {
    // Given: an idle session prompt rendered at terminal size.
    const adapter = createCapturingAdapter([])
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    // When: the frame is captured.
    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    // Then: it includes the prompt input hint and cockpit model/status row affordances.
    expect(frame).toContain("Ask Wren anything")
    expect(frame).toContain("Wren")
    expect(frame).toContain("glm-5.2")
    expect(frame).toContain("Enter send")
    setup.renderer.destroy()
  })

  test("home model command opens picker without creating a session", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("/models")
    setup.mockInput.pressEnter()
    await setup.flush()
    await setup.renderOnce()

    expect(requests).toEqual([])
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("/models")
    setup.renderer.destroy()
  })

  test("home help command is handled without creating a session", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }}>
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("/help")
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(setup.captureCharFrame()).toContain("Home commands")
    expect(requests).toEqual([])
    setup.renderer.destroy()
  })

  test("does not paste into a disabled prompt", async () => {
    const adapter = createCapturingAdapter([])
    adapter.state.addSession({
      id: SESSION_ID,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    adapter.state.setStatus(SESSION_ID, { type: "idle" })
    const [inputDisabled, setInputDisabled] = createSignal(false)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "session", sessionId: SESSION_ID }}>
          <Prompt sessionId={SESSION_ID} inputDisabled={inputDisabled()} />
        </TestProviders>
      ),
      { width: 80, height: 12 },
    )

    await setup.mockInput.pasteBracketedText("allowed paste")
    await setup.flush()
    setInputDisabled(true)
    await setup.mockInput.pasteBracketedText("blocked paste")
    await setup.flush()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("allowed paste")
    expect(frame).not.toContain("blocked paste")
    setup.renderer.destroy()
  })
})

describe("home sessions command", () => {
  test("home sessions command opens the session list dialog", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createHomeAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter} initialRoute={{ type: "home" }} initialModel="glm-5.2">
          <Home />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.mockInput.typeText("/sessions")
    setup.mockInput.pressEnter()
    await setup.flush()
    await setup.renderOnce()
    await setup.renderOnce()
    await setup.renderOnce()

    expect(requests).toEqual([])
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("/sessions")
    expect(frame).toContain("Sessions")
    expect(frame).toContain("No sessions found")
    setup.renderer.destroy()
  })
})

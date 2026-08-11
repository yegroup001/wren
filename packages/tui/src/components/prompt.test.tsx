import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { ClipboardProvider } from "../context/clipboard"
import { DialogProvider } from "../context/dialog"
import { LocalProvider } from "../context/local"
import type { Route } from "../context/route"
import { RouteProvider } from "../context/route"
import { StoreProvider } from "../context/store"
import { ThemeProvider } from "../context/theme"
import { KeymapProvider } from "../keymap"
import { Toast, ToastProvider } from "../ui/toast"
import { Prompt } from "./prompt"

const SESSION_ID = parseSessionId("ses_test_prompt")

function createFailingAdapter(): WrenAdapter {
  const store = createTuiStore()
  store.addSession({
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "fake/model",
    permissionMode: "default",
  })
  return {
    state: store,
    async fetch(): Promise<Response> {
      return new Response(JSON.stringify({ error: "session_busy" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

type CapturedRequest = {
  readonly path: string
  readonly body: string
}

function createCapturingAdapter(
  requests: CapturedRequest[],
  messageResponse?: { readonly status: number; readonly body: object },
): WrenAdapter {
  const store = createTuiStore()
  store.addSession({
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "fake/model",
    permissionMode: "default",
  })
  return {
    state: store,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname
      requests.push({ path, body: await request.text() })
      if (path.endsWith("/message") && messageResponse !== undefined) {
        return new Response(JSON.stringify(messageResponse.body), {
          status: messageResponse.status,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: path.endsWith("/message") ? 202 : 200,
        headers: { "content-type": "application/json" },
      })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(
  props: ParentProps<{
    adapter: WrenAdapter
    initialRoute?: Route
  }>,
): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute ?? { type: "session", sessionId: SESSION_ID }}>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider initialCwd="/tmp" initialModel="fake/model">
            <ClipboardProvider>
              <DialogProvider>
                <ToastProvider>
                  <KeymapProvider>
                    {props.children}
                    <Toast />
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

describe("prompt submit failure handling", () => {
  test("/models test preserves the source-qualified model ID", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    await setup.flush()
    await setup.mockInput.typeText("/models test secondary/shared", 0)
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([
      {
        path: `/session/${SESSION_ID}/model/test`,
        body: JSON.stringify({ modelId: "secondary/shared" }),
      },
    ])
    setup.renderer.destroy()
  })

  test("handleSubmit should not append history before fetch succeeds", () => {
    const source = readFileSync(join(import.meta.dir, "prompt.tsx"), "utf8")
    const fullPromptIdx = source.indexOf("const fullPrompt = trimmed")
    const fetchIdx = source.indexOf("const response = await adapter.fetch", fullPromptIdx)
    expect(fullPromptIdx).toBeGreaterThan(-1)
    expect(fetchIdx).toBeGreaterThan(-1)
    const section = source.slice(fullPromptIdx, fetchIdx)
    expect(section).not.toContain("history.append(trimmed)")
  })

  test("input text is retained after failed submit (409)", async () => {
    const adapter = createFailingAdapter()

    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    await setup.flush()

    await setup.mockInput.typeText("hello world", 0)
    await setup.flush()

    setup.mockInput.pressEnter()
    await setup.flush()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("hello world")

    setup.renderer.destroy()
  })

  test("reported edit failure retains the draft and edit ID without a duplicate toast", async () => {
    // Given: a prompt preloaded for edit and an adapter that already reported the terminal error.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests, {
      status: 500,
      body: { reported: true, message: "resend failed" },
    })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When: the edit fails and the user retries without changing the draft.
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the request includes the edit anchor, and on failure the draft clears.
    const expectedBody = JSON.stringify({ prompt: "edited draft", editMessageId: "msg_original" })
    expect(requests.map((request) => request.body)).toEqual([expectedBody])
    setup.renderer.destroy()
  })

  test("staged edit preloads the draft text", async () => {
    const adapter = createCapturingAdapter([])
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    await setup.flush()
    const frame = setup.captureCharFrame()

    expect(frame).toContain("edited draft")
    setup.renderer.destroy()
  })

  test("Escape cancels a staged edit locally without posting", async () => {
    // Given: an edit draft staged in the prompt.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When: Escape is pressed before submission.
    setup.renderer.keyInput.processParsedKey({
      name: "escape",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "\x1b",
      number: false,
      raw: "\x1b",
      eventType: "press",
      source: "raw",
    })
    await setup.flush()

    // Then: the edit anchor and copied draft are cleared without any request.
    const frame = setup.captureCharFrame()
    expect(requests).toEqual([])
    expect(frame).not.toContain("edited draft")
    expect(frame).not.toContain("Next Enter replaces the later branch")
    expect(frame).toContain("Ask Wren anything")
    expect(frame).toContain("Enter send")
    setup.renderer.destroy()
  })

  test("Ctrl+L cancels a staged edit locally without posting", async () => {
    // Given: an edit draft staged in the prompt.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When: Ctrl+L clears the prompt before submission.
    setup.mockInput.pressKey("l", { ctrl: true })
    await setup.flush()

    // Then: clear keeps its visible semantics and also drops the edit anchor.
    const frame = setup.captureCharFrame()
    expect(requests).toEqual([])
    expect(frame).not.toContain("edited draft")
    expect(frame).not.toContain("Next Enter replaces the later branch")
    expect(frame).toContain("Ask Wren anything")
    expect(frame).toContain("Enter send")
    setup.renderer.destroy()
  })

  test("Enter submits the existing edit payload while staged", async () => {
    // Given: a staged replacement draft.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When: the staged replacement is submitted.
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the POST body preserves the established adapter contract exactly.
    expect(requests).toEqual([
      {
        path: `/session/${SESSION_ID}/message`,
        body: JSON.stringify({ prompt: "edited draft", editMessageId: "msg_original" }),
      },
    ])
    setup.renderer.destroy()
  })

  test("clear slash command cancels a pending edit before the next prompt", async () => {
    // Given: `/clear` entered while an edit ID is pending.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="/clear" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When: clear is handled and a fresh prompt is submitted.
    setup.mockInput.pressEnter()
    await setup.flush()
    await setup.mockInput.typeText("fresh prompt", 0)
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the fresh message is not attached to the stale edit anchor.
    expect(requests).toEqual([
      { path: `/session/${SESSION_ID}/clear`, body: "" },
      { path: `/session/${SESSION_ID}/message`, body: JSON.stringify({ prompt: "fresh prompt" }) },
    ])
    setup.renderer.destroy()
  })

  test("Ctrl+L cancels a pending edit before the next prompt", async () => {
    // Given: a prompt preloaded for edit.
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When: Ctrl+L clears edit mode and a fresh prompt is submitted.
    setup.mockInput.pressKey("l", { ctrl: true })
    await setup.flush()
    await setup.mockInput.typeText("fresh prompt", 0)
    setup.mockInput.pressEnter()
    await setup.flush()

    // Then: the fresh message is submitted without the stale edit ID.
    expect(requests).toEqual([
      { path: `/session/${SESSION_ID}/message`, body: JSON.stringify({ prompt: "fresh prompt" }) },
    ])
    setup.renderer.destroy()
  })

  test("goal set uses the control route without posting a user message", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="/goal Finish the migration" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([
      {
        path: `/session/${SESSION_ID}/goal`,
        body: JSON.stringify({ action: "set", objective: "Finish the migration" }),
      },
    ])
    expect(setup.captureCharFrame()).not.toContain("/goal Finish the migration")
    setup.renderer.destroy()
  })
  test("models set --user persists a source-qualified user default model", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="/models set user-source/user-model --user" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([
      {
        path: "/config/default-model",
        body: JSON.stringify({ modelId: "user-source/user-model", scope: "user" }),
      },
    ])
    setup.renderer.destroy()
  })

  test("models set --project is rejected without a request", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt
            sessionId={SESSION_ID}
            editText="/models set test-source/project-model --project"
          />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([])
    expect(setup.captureCharFrame()).toContain("Scope not supported")
    setup.renderer.destroy()
  })

  test("disabled prompt does not submit on Enter", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests)
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="hidden draft" inputDisabled />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(requests).toEqual([])
    setup.renderer.destroy()
  })

  test("session_busy clears the edit anchor so the next message is fresh", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests, {
      status: 409,
      body: {
        error: "session_busy",
        message: "a newer run started while waiting for finalization",
      },
    })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    // When the edit hits session_busy, the edit anchor is cleared.
    setup.mockInput.pressEnter()
    await setup.flush()

    expect(setup.captureCharFrame()).toContain("Edit cancelled")

    // The next message should NOT carry editMessageId.
    await setup.mockInput.typeText("fresh prompt", 0)
    setup.mockInput.pressEnter()
    await setup.flush()

    const messageRequest = requests.find(
      (r) => r.path.endsWith("/message") && r.body.includes("fresh prompt"),
    )
    expect(messageRequest).toBeDefined()
    expect(JSON.parse(messageRequest?.body)).not.toHaveProperty("editMessageId")
    setup.renderer.destroy()
  })

  test("edit_message_not_found clears the edit anchor and draft", async () => {
    const requests: CapturedRequest[] = []
    const adapter = createCapturingAdapter(requests, {
      status: 404,
      body: {
        error: "edit_message_not_found",
        message: "editable user message not found: msg_original",
      },
    })
    const setup = await testRender(
      () => (
        <TestProviders adapter={adapter}>
          <Prompt sessionId={SESSION_ID} editText="edited draft" editMessageId="msg_original" />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )
    await setup.renderOnce()
    await setup.flush()

    setup.mockInput.pressEnter()
    await setup.flush()

    expect(setup.captureCharFrame()).toContain("Edit unavailable")
    expect(setup.captureCharFrame()).not.toContain("edited draft")

    // The next message should not carry the stale edit anchor.
    await setup.mockInput.typeText("new message", 0)
    setup.mockInput.pressEnter()
    await setup.flush()

    const messageRequest = requests.find(
      (r) => r.path.endsWith("/message") && r.body.includes("new message"),
    )
    expect(messageRequest).toBeDefined()
    expect(JSON.parse(messageRequest?.body)).not.toHaveProperty("editMessageId")
    setup.renderer.destroy()
  })
})

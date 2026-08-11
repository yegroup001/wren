import { describe, expect, test } from "bun:test"
import type { PermissionResolver, SDKMessage, WrenEngine, WrenEngineFactory } from "@wren/engine"
import { EngineHistorySnapshot } from "@wren/engine"
import { parseSessionId } from "@wren/protocol"
import { createRoot } from "solid-js"
import { createWrenAdapter, type WrenAdapter } from "./local-adapter"

// ---------------------------------------------------------------------------
// RetryTestEngine — fails on first submit, succeeds on retry.
// Tracks messages so the edit-resend anchor check works.
// ---------------------------------------------------------------------------

class RetryTestEngine implements WrenEngine {
  submitCount = 0
  readonly submitMessageCalls: string[] = []
  private model = "fake/model"
  private readonly historyOwner = {}
  private messages: unknown[] = []

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    this.submitCount++

    // Track the user prompt so isEngineUserPrompt recognizes it
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
    })

    yield {
      type: "system",
      subtype: "init",
      cwd: "/tmp/project",
      session_id: "ses_fake",
      tools: [],
      model: this.model,
      permissionMode: "default",
      uuid: "00000000-0000-0000-0000-000000000001",
    } as SDKMessage

    if (this.submitCount === 1) {
      // First attempt: simulate an API error
      yield {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: "error",
        session_id: "ses_fake",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "API Error: connection refused",
      } as SDKMessage
    } else {
      // Retry: succeed
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_api_retry",
          content: [{ type: "text", text: "retry succeeded" }],
        },
        uuid: "00000000-0000-0000-0000-000000000010",
      } as SDKMessage
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: "end_turn",
        session_id: "ses_fake",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "",
      } as SDKMessage
    }
  }

  interrupt(): void {}
  resetAbortController(): void {}
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model
  }
  setPermissionResolver(_resolver: PermissionResolver | null): void {}
  setPermissionMode(_mode: string): void {}
  setPermissionModeChangeCallback(_cb: ((mode: string) => void) | null): void {}
  getMessages(): readonly unknown[] {
    return this.messages
  }
  truncateMessages(count: number): void {
    this.messages = this.messages.slice(0, count)
  }
  snapshotHistory(): EngineHistorySnapshot {
    return EngineHistorySnapshot.capture(this.historyOwner, [], () => {})
  }
  restoreHistory(snapshot: EngineHistorySnapshot): void {
    snapshot.restoreFor(this.historyOwner)
  }
  dispose(): void {}
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://wren.internal${path}`, init)
}

async function createSession(adapter: WrenAdapter): Promise<{ id: string }> {
  const response = await adapter.fetch(
    request("/session", {
      method: "POST",
      body: JSON.stringify({ cwd: "/tmp/project" }),
    }),
  )
  if (!response.ok) throw new Error(`create session failed: ${response.status}`)
  return (await response.json()) as { id: string }
}

async function sendMessage(
  adapter: WrenAdapter,
  sessionId: string,
  prompt: string,
): Promise<Response> {
  return adapter.fetch(
    request(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  )
}

async function retryLastPrompt(adapter: WrenAdapter, sessionId: string): Promise<Response> {
  return adapter.fetch(request(`/session/${sessionId}/retry`, { method: "POST" }))
}

async function waitForIdle(
  adapter: WrenAdapter,
  sessionId: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bundle = adapter.state.getBundle(parseSessionId(sessionId))
    if (bundle?.status.type === "idle") return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`session ${sessionId} did not reach idle within ${timeoutMs}ms`)
}

function makeFactory(engine: WrenEngine): WrenEngineFactory {
  return {
    createEngine: () => engine,
    getDefaultModel: () => "fake/model",
    getCommands: () => [],
    getAgents: () => [],
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("retry race condition", () => {
  test("retry after failure succeeds when finalization is complete", async () => {
    const engine = new RetryTestEngine()
    const { adapter, dispose } = createRoot((dispose) => ({
      adapter: createWrenAdapter(engine, { engineFactory: makeFactory(engine) }),
      dispose,
    }))

    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    // Send first prompt — will fail
    await sendMessage(adapter, session.id, "hello")
    await waitForIdle(adapter, session.id)

    // Error message should be visible
    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle).toBeDefined()
    const errorMsg = bundle?.messages.find((m) => m.error !== undefined)
    expect(errorMsg).toBeDefined()
    expect(errorMsg?.error).toContain("connection refused")

    // Retry should succeed now that finalization is complete
    const retryResponse = await retryLastPrompt(adapter, session.id)
    expect(retryResponse.ok).toBe(true)
    await waitForIdle(adapter, session.id)

    // Verify the retry actually ran
    expect(engine.submitCount).toBe(2)

    // Verify the retry's response message is present
    const updatedBundle = adapter.state.getBundle(sessionId)
    const retryMsg = updatedBundle?.messages.find((m) =>
      m.parts.some((p) => p.type === "text" && p.text === "retry succeeded"),
    )
    expect(retryMsg).toBeDefined()

    dispose()
  })

  test("retry waits for finalization barrier instead of returning 409", async () => {
    // This is the core race condition test: when retry is called while
    // the failed run's finalization is still in progress, it should
    // await the barrier and then proceed, not return 409.
    const engine = new RetryTestEngine()
    const { adapter, dispose } = createRoot((dispose) => ({
      adapter: createWrenAdapter(engine, { engineFactory: makeFactory(engine) }),
      dispose,
    }))

    const session = await createSession(adapter)

    // Send the first prompt — it will fail. Don't wait for idle.
    // The HTTP response returns 202 immediately while runPrompt runs in background.
    await sendMessage(adapter, session.id, "hello")

    // Wait for the error message to appear (the race window where
    // error is visible but runningPrompt hasn't been cleared yet).
    let errorVisible = false
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const bundle = adapter.state.getBundle(parseSessionId(session.id))
      const err = bundle?.messages.find((m) => m.error !== undefined)
      if (err !== undefined) {
        errorVisible = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(errorVisible).toBe(true)

    // Now retry WHILE the first run may still be finalizing.
    // The old code would return 409 here. The fixed code should wait.
    const retryResponse = await retryLastPrompt(adapter, session.id)
    expect(retryResponse.ok).toBe(true)

    // Wait for the retry to complete
    await waitForIdle(adapter, session.id)

    // Verify both submissions ran
    expect(engine.submitCount).toBe(2)

    dispose()
  })

  test("retry returns 404 when session is deleted before retry", async () => {
    const engine = new RetryTestEngine()
    const { adapter, dispose } = createRoot((dispose) => ({
      adapter: createWrenAdapter(engine, { engineFactory: makeFactory(engine) }),
      dispose,
    }))

    const session = await createSession(adapter)

    // Send the first prompt — it will fail
    await sendMessage(adapter, session.id, "hello")
    await waitForIdle(adapter, session.id)

    // Delete the session
    await adapter.fetch(request(`/session/${session.id}`, { method: "DELETE" }))

    // Retry should return 404
    const retryResponse = await retryLastPrompt(adapter, session.id)
    expect(retryResponse.status).toBe(404)

    dispose()
  })

  test("retry returns 400 when there is no user prompt to retry", async () => {
    const engine = new RetryTestEngine()
    const { adapter, dispose } = createRoot((dispose) => ({
      adapter: createWrenAdapter(engine, { engineFactory: makeFactory(engine) }),
      dispose,
    }))

    const session = await createSession(adapter)

    // No prompt sent — retry should return 400
    const retryResponse = await retryLastPrompt(adapter, session.id)
    expect(retryResponse.status).toBe(400)
    const body = await retryResponse.json()
    expect(body.error).toBe("no_prompt")

    dispose()
  })

  test("TUI retry surfaces non-2xx errors instead of silently discarding them", async () => {
    // This test verifies the TUI-side fix at the adapter level: the retry
    // endpoint returns a structured error body that the TUI can parse.
    const engine = new RetryTestEngine()
    const { adapter, dispose } = createRoot((dispose) => ({
      adapter: createWrenAdapter(engine, { engineFactory: makeFactory(engine) }),
      dispose,
    }))

    const session = await createSession(adapter)

    // Retry with no prompt → 400 with structured error
    const retryResponse = await retryLastPrompt(adapter, session.id)
    expect(retryResponse.status).toBe(400)
    const body = await retryResponse.json()
    expect(body.error).toBeDefined()
    expect(body.message).toBeDefined()
    expect(typeof body.message).toBe("string")

    dispose()
  })
})

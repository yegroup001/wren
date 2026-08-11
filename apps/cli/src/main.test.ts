import { describe, expect, test } from "bun:test"
import { createWrenAdapter, createWrenRequest, type WrenAdapter } from "@wren/adapter"
import type { PermissionResolver, SDKMessage, WrenEngine } from "@wren/engine"
import { EngineHistorySnapshot } from "@wren/engine"
import { createRoot } from "solid-js"
import { runNonInteractive } from "./main"

process.env.WREN_USE_OPENAI = "1"
process.env.OPENAI_API_KEY = "test-key-not-real"
process.env.OPENAI_BASE_URL = "https://example.invalid/v1"
process.env.OPENAI_MODEL = "gpt-5.5"

const FIXED_NOW = "2026-07-09T00:00:00.000Z"

class FakeWrenEngine implements WrenEngine {
  readonly submitMessageCalls: string[] = []
  protected readonly responseText: string
  private model = "gpt-5.5"
  private responseCount = 0
  private readonly historyOwner = {}

  constructor(responseText: string) {
    this.responseText = responseText
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    yield {
      type: "system",
      subtype: "init",
      cwd: "/tmp/project",
      session_id: "ses_fake",
      tools: [],
      model: "gpt-5.5",
      permissionMode: "default",
      uuid: "00000000-0000-0000-0000-000000000001",
    } as SDKMessage
    this.responseCount += 1
    const responseSequence = this.responseCount.toString().padStart(12, "0")
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        id: `msg_api_fake_${responseSequence}`,
        content: [{ type: "text", text: this.responseText }],
      },
      uuid: `00000000-0000-0000-0000-${responseSequence}`,
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

  interrupt(): void {}
  resetAbortController(): void {}
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model
  }
  setPermissionResolver(_resolver: PermissionResolver | null): void {}
  getMessages(): readonly unknown[] {
    return []
  }
  truncateMessages(_count: number): void {}
  snapshotHistory(): EngineHistorySnapshot {
    return EngineHistorySnapshot.capture(this.historyOwner, [], () => {})
  }
  restoreHistory(snapshot: EngineHistorySnapshot): void {
    snapshot.restoreFor(this.historyOwner)
  }
  dispose(): void {}
}

class FailedFakeWrenEngine extends FakeWrenEngine {
  constructor() {
    super("unused")
  }

  override async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    yield {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: null,
      session_id: "ses_fake",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 0 },
      errors: ["provider failed"],
    } as SDKMessage
  }
}

class QueuedDrainFakeWrenEngine extends FakeWrenEngine {
  private readonly firstTurn = Promise.withResolvers<void>()
  private readonly secondTurn = Promise.withResolvers<void>()

  constructor() {
    super("unused")
  }

  override async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    if (this.submitMessageCalls.length === 1) await this.firstTurn.promise
    else await this.secondTurn.promise
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        id: `msg_${prompt}`,
        content: [{ type: "text", text: `response ${prompt}` }],
      },
      uuid: `uuid-${prompt}`,
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

  releaseFirstTurn(): void {
    this.firstTurn.resolve()
  }

  releaseSecondTurn(): void {
    this.secondTurn.resolve()
  }
}

async function waitForSubmitCount(
  engine: { readonly submitMessageCalls: readonly string[] },
  expected: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (engine.submitMessageCalls.length >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`engine did not receive ${expected} prompts within ${timeoutMs}ms`)
}

function setupAdapter(responseText: string): {
  adapter: WrenAdapter
  engine: FakeWrenEngine
  dispose: () => void
} {
  return createRoot((dispose) => {
    const engine = new FakeWrenEngine(responseText)
    const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })
    return { adapter, engine, dispose }
  })
}

describe("runNonInteractive", () => {
  test("sends a prompt and returns assistant text", async () => {
    const { adapter, engine, dispose } = setupAdapter("hello back")
    const fetch = adapter.fetch.bind(adapter)
    let promptBody: unknown
    adapter.fetch = async (request) => {
      if (new URL(request.url).pathname.endsWith("/message")) {
        promptBody = await request.clone().json()
      }
      return fetch(request)
    }

    const output = await runNonInteractive(adapter, "/tmp/project", {
      prompt: "hello",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })

    expect(engine.submitMessageCalls).toEqual(["hello"])
    expect(promptBody).toEqual({ prompt: "hello", disableGoalContinuation: true })
    expect(output).toContain("hello back")
    dispose()
  })

  test("preserves a source-qualified model selection for a new session", async () => {
    const { adapter, engine, dispose } = setupAdapter("source-aware response")

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "hello",
      modelId: "secondary/shared",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })

    expect(adapter.state.store.sessions[0]?.modelId).toBe("secondary/shared")
    expect(adapter.state.store.sessions[0]?.modelRef).toEqual({
      source: "secondary",
      model: "shared",
    })
    expect(engine.getModel()).toBe("secondary/shared")
    dispose()
  })

  test("--session resumes an existing session and sends the prompt to it", async () => {
    const { adapter, engine, dispose } = setupAdapter("resumed response")

    const first = await runNonInteractive(adapter, "/tmp/project", {
      prompt: "first prompt",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })
    expect(first).toContain("resumed response")
    expect(engine.submitMessageCalls).toHaveLength(1)

    const sessions = adapter.state.store.sessions
    expect(sessions.length).toBe(1)
    const sessionId = sessions[0]?.id

    engine.submitMessageCalls.length = 0
    const second = await runNonInteractive(adapter, "/tmp/project", {
      prompt: "second prompt",
      modelId: "gpt-5.5",
      sessionId,
      continueSession: false,
      auto: false,
    })

    expect(second).toBe("resumed response")
    expect(engine.submitMessageCalls).toEqual(["second prompt"])
    expect(adapter.state.store.sessions.length).toBe(1)
    dispose()
  })

  test("--session with --auto updates the existing session permission mode", async () => {
    const { adapter, dispose } = setupAdapter("resumed auto response")

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "first prompt",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })
    const sessionId = adapter.state.store.sessions[0]?.id

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "second prompt",
      modelId: "gpt-5.5",
      sessionId,
      continueSession: false,
      auto: true,
    })

    expect(adapter.state.store.sessions[0]?.permissionMode).toBe("auto")
    dispose()
  })

  test("--continue resumes the most recent session", async () => {
    const { adapter, engine, dispose } = setupAdapter("continued response")

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "first",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })

    engine.submitMessageCalls.length = 0
    const output = await runNonInteractive(adapter, "/tmp/project", {
      prompt: "second",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: true,
      auto: false,
    })

    expect(output).toContain("continued response")
    expect(adapter.state.store.sessions.length).toBe(1)
    expect(engine.submitMessageCalls).toEqual(["second"])
    dispose()
  })

  test("--continue with --auto updates the resumed session permission mode", async () => {
    const { adapter, dispose } = setupAdapter("continued auto response")

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "first",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "second",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: true,
      auto: true,
    })

    expect(adapter.state.store.sessions[0]?.permissionMode).toBe("auto")
    dispose()
  })

  test("--session without --auto resets an auto session to default", async () => {
    const { adapter, dispose } = setupAdapter("resumed default response")

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "first prompt",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: true,
    })
    const sessionId = adapter.state.store.sessions[0]?.id
    expect(adapter.state.store.sessions[0]?.permissionMode).toBe("auto")

    await runNonInteractive(adapter, "/tmp/project", {
      prompt: "second prompt",
      modelId: "gpt-5.5",
      sessionId,
      continueSession: false,
      auto: false,
    })

    expect(adapter.state.store.sessions[0]?.permissionMode).toBe("default")
    dispose()
  })

  test("sets a nonzero exit code when the adapter run fails", async () => {
    const engine = new FailedFakeWrenEngine()
    const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })

    let exitCode: number | undefined
    const output = await runNonInteractive(
      adapter,
      "/tmp/project",
      {
        prompt: "fail this run",
        modelId: "gpt-5.5",
        sessionId: undefined,
        continueSession: false,
        auto: false,
      },
      {
        setExitCode: (code) => {
          exitCode = code
        },
      },
    )

    expect(output).toContain("provider failed")
    expect(exitCode).toBe(1)
  })

  test("waits for every queued prompt to drain before returning", async () => {
    const engine = new QueuedDrainFakeWrenEngine()
    const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })

    const firstRun = runNonInteractive(adapter, "/tmp/project", {
      prompt: "first",
      modelId: "gpt-5.5",
      sessionId: undefined,
      continueSession: false,
      auto: false,
    })
    await waitForSubmitCount(engine, 1)
    const sessionId = adapter.state.store.sessions[0]?.id
    const queuedResponse = await adapter.fetch(
      createWrenRequest(`/session/${sessionId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "second" }),
      }),
    )
    expect(queuedResponse.status).toBe(202)

    let returned = false
    void firstRun.then(() => {
      returned = true
    })
    engine.releaseFirstTurn()
    await waitForSubmitCount(engine, 2)
    expect(returned).toBe(false)
    engine.releaseSecondTurn()

    const output = await firstRun
    expect(engine.submitMessageCalls).toEqual(["first", "second"])
    expect(output).toContain("response second")
  })

  test("invalid --session throws a usage error", async () => {
    const { adapter, dispose } = setupAdapter("x")

    await expect(
      runNonInteractive(adapter, "/tmp/project", {
        prompt: "hello",
        modelId: "gpt-5.5",
        sessionId: "ses_missing",
        continueSession: false,
        auto: false,
      }),
    ).rejects.toThrow("session not found: ses_missing")

    dispose()
  })

  test("--continue with no previous session throws a usage error", async () => {
    const { adapter, dispose } = setupAdapter("x")

    await expect(
      runNonInteractive(adapter, "/tmp/project", {
        prompt: "hello",
        modelId: "gpt-5.5",
        sessionId: undefined,
        continueSession: true,
        auto: false,
      }),
    ).rejects.toThrow("no previous session to continue")

    dispose()
  })
})

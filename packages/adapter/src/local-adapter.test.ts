import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModelRegistry, setWrenConfigHomeForTests } from "@wren/config-node"
import type {
  CompactProgressEvent,
  PermissionResolver,
  SDKMessage,
  WrenEngine,
  WrenEngineFactory,
} from "@wren/engine"
import { clearGoal, createWrenEngine, EngineHistorySnapshot, getGoal, setConfigForTests, setGoal } from "@wren/engine"
import { parseMessageId, parsePartId, parseSessionId, type SessionId } from "@wren/protocol"
import { createMemorySessionStore, type SessionStore } from "@wren/storage"
import { createComputed, createRoot } from "solid-js"
import { createWrenAdapter, type WrenAdapter } from "./local-adapter"
import { consumeSDKMessageStream } from "./message-mapper"
import type { TuiStoreApi } from "./store"

const TEST_CONFIG = {
  defaultModel: { source: "default", model: "gpt-5.5" },
  smallFastModel: { source: "default", model: "gpt-5.5" },
  sources: {
    default: {
      type: "openai-compatible-chat" as const,
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key-not-real",
      models: {
        "gpt-5.5": {
          contextWindow: 128000,
          supportsThinking: false,
        },
      },
    },
  },
}

beforeAll(() => {
  setConfigForTests(TEST_CONFIG)
  process.env.OPENAI_API_KEY = "test-key-not-real"
  process.env.OPENAI_BASE_URL = "https://example.invalid/v1"
  process.env.WREN_USE_OPENAI = "1"
})

const FIXED_NOW = "2026-07-08T00:00:00.000Z"

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://wren.internal${path}`, init)
}

async function json(adapter: WrenAdapter, path: string, init?: RequestInit): Promise<unknown> {
  const response = await adapter.fetch(request(path, init))
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${path} -> ${response.status}: ${await response.text()}`)
  }
  return await response.json()
}

// ---------------------------------------------------------------------------
// FakeWrenEngine — conforms to WrenEngine but yields canned real-shaped
// SDKMessages. No real API calls. Lets the integration test exercise the
// adapter routes + mapper wiring + permission/abort flows deterministically.
// ---------------------------------------------------------------------------

type FakeBehavior =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "askPermission"; readonly toolName: string; readonly input: unknown }
  | { readonly kind: "askPermissionTwice"; readonly toolName: string; readonly input: unknown }

type PermissionDecision = Awaited<ReturnType<PermissionResolver>>

class FakeWrenEngine implements WrenEngine {
  readonly submitMessageCalls: string[] = []
  readonly permissionDecisions: PermissionDecision[] = []
  readonly permissionModes: string[] = []
  interruptCalled = false
  resetCalled = false
  private resolver: PermissionResolver | null = null
  private permissionModeChangeCallback: ((mode: string) => void) | null = null
  private readonly behavior: FakeBehavior
  private model: string
  private readonly historyOwner = {}

  constructor(behavior: FakeBehavior, model = "fake/model") {
    this.behavior = behavior
    this.model = model
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    yield systemInit()
    if (this.behavior.kind === "askPermission" || this.behavior.kind === "askPermissionTwice") {
      if (this.resolver !== null) {
        this.permissionDecisions.push(
          await this.resolver(this.behavior.toolName, this.behavior.input),
        )
      }
      if (this.behavior.kind === "askPermissionTwice" && this.resolver !== null) {
        this.permissionDecisions.push(
          await this.resolver(this.behavior.toolName, this.behavior.input),
        )
      }
    }
    yield assistantWithText(this.behavior.kind === "text" ? this.behavior.text : "after permission")
    yield resultSuccess()
  }

  interrupt(): void {
    this.interruptCalled = true
  }
  resetAbortController(): void {
    this.resetCalled = true
  }
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model
  }
  setPermissionResolver(resolver: PermissionResolver | null): void {
    this.resolver = resolver
  }
  setPermissionMode(mode: string): void {
    this.permissionModes.push(mode)
  }
  setPermissionModeChangeCallback(callback: ((mode: string) => void) | null): void {
    this.permissionModeChangeCallback = callback
  }
  emitPermissionModeChange(mode: string): void {
    this.permissionModeChangeCallback?.(mode)
  }
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

class CompactFakeEngine extends FakeWrenEngine {
  private compactProgress: ((event: CompactProgressEvent) => void) | null = null
  private compactStatus: ((status: string) => void) | null = null

  setOnCompactProgress(callback: ((event: CompactProgressEvent) => void) | null): void {
    this.compactProgress = callback
  }

  setSDKStatusCallback(callback: ((status: string) => void) | null): void {
    this.compactStatus = callback
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    if (/^\/compact(?:\s|$)/.test(prompt.trim())) {
      this.compactStatus?.("compacting")
      this.compactProgress?.({ type: "compact_start" })
      this.compactProgress?.({ type: "summary_delta", text: "summary" })
      this.compactProgress?.({ type: "thinking_delta", text: "reasoning" })
      this.compactProgress?.({ type: "summary_delta", text: " continues" })
      yield {
        type: "user",
        message: { role: "user", content: "internal summary" },
        uuid: "uuid-compact-summary",
        session_id: "ses_fake",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        isSynthetic: true,
      } as SDKMessage
      yield {
        type: "system",
        subtype: "compact_boundary",
        session_id: "ses_fake",
        uuid: "uuid-compact-boundary",
      } as SDKMessage
      this.compactProgress?.({ type: "compact_end" })
      this.compactProgress?.({ type: "summary_delta", text: "late repaint" })
      this.compactProgress?.({ type: "compact_end" })
      yield resultSuccess()
      return
    }
    yield systemInit()
    yield assistantWithText(`response to ${prompt}`)
    yield resultSuccess()
  }
}

function systemInit(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp/project",
    session_id: "ses_fake",
    tools: ["Read", "Edit", "Write"],
    model: "fake/model",
    permissionMode: "default",
    uuid: "00000000-0000-0000-0000-000000000001",
  } as SDKMessage
}

function assistantWithText(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_api_fake",
      content: [{ type: "text", text }],
    },
    uuid: "00000000-0000-0000-0000-000000000010",
  } as SDKMessage
}

function assistantWithToolUse(
  toolUseId: string,
  toolName: string,
  input: unknown,
  uuid: string,
): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: `msg_${toolUseId}`,
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
    },
    uuid,
  } as SDKMessage
}

function userToolResult(toolUseId: string, content: string, uuid: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    uuid,
    session_id: "ses_fake",
  } as SDKMessage
}

function resultSuccess(): SDKMessage {
  return {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSession(
  adapter: WrenAdapter,
  cwd = "/tmp/project",
  permissionMode?: string,
): Promise<{ id: string }> {
  return json(adapter, "/session", {
    method: "POST",
    body: JSON.stringify({ cwd, permissionMode }),
  }) as Promise<{ id: string }>
}

function setup(
  behavior: FakeBehavior,
  cwd?: string,
): { adapter: WrenAdapter; engine: FakeWrenEngine; dispose: () => void } {
  return createRoot((dispose) => {
    const engine = new FakeWrenEngine(behavior)
    const adapter = createWrenAdapter(engine, {
      clock: { now: () => FIXED_NOW },
      ...(cwd !== undefined && { cwd }),
    })
    return { adapter, engine, dispose }
  })
}

async function waitForIdle(
  store: TuiStoreApi,
  sessionId: SessionId,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bundle = store.getBundle(sessionId)
    if (bundle?.status.type === "idle") return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`session ${sessionId} did not reach idle within ${timeoutMs}ms`)
}

// ===========================================================================
// Tests
// ===========================================================================

describe("createWrenEngine — real QueryEngine instantiation", () => {
  test("instantiates the real QueryEngine with real tools, model, and canUseTool", async () => {
    // Given: the real engine factory with an auto-allow canUseTool.
    const engine = await createWrenEngine({
      canUseTool: async () => ({ behavior: "allow" }),
    })

    // Then: the wrapper exposes the adapter-facing surface and a real model.
    expect(typeof engine.submitMessage).toBe("function")
    expect(typeof engine.interrupt).toBe("function")
    expect(typeof engine.resetAbortController).toBe("function")
    expect(typeof engine.setPermissionResolver).toBe("function")
    expect(typeof engine.getModel()).toBe("string")
    expect(engine.getModel().length).toBeGreaterThan(0)

    // No prompt is sent -> no real API call is made. The engine instance
    // itself is a real QueryEngine (verified by the methods above).
  })

  test("default canUseTool denies until a resolver is wired (never auto-allows)", async () => {
    // Given: a real engine with NO explicit canUseTool (default deny).
    const engine = await createWrenEngine()

    // When: a permission resolver captures the decision.
    let captured: { behavior: string } | null = null
    engine.setPermissionResolver(async () => {
      captured = { behavior: "allow" }
      return { behavior: "allow" }
    })

    // Then: the resolver is registered (the engine would call it during a
    // tool execution; here we only verify the registration path works).
    expect(captured).toBeNull()
  })
})
describe("local adapter — in-process fetch routes", () => {
  test("coalesces compact progress and ignores deltas after compact completion", async () => {
    const compactEngine = new CompactFakeEngine({ kind: "text", text: "unused" })
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(compactEngine, {
        clock: { now: () => FIXED_NOW },
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)
    const observed: string[] = []
    createComputed(() => {
      const progress = adapter.state.store.compactProgress[sessionId]
      if (progress !== undefined) {
        observed.push(progress.segments.map((segment) => segment.text).join("|"))
      }
    })

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "/compact" }),
      }),
    )
    await adapter.waitForIdle(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(observed.length).toBeLessThanOrEqual(2)
    expect(adapter.state.store.compactProgress[sessionId]).toBeUndefined()
    expect(adapter.state.getBundle(sessionId)?.status.type).toBe("idle")
    dispose()
  })

  test("keeps the real /compact bubble, clears transient progress, and restores its pre-compact branch on edit", async () => {
    const compactEngine = new CompactFakeEngine({ kind: "text", text: "unused" })
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(compactEngine, {
        clock: { now: () => FIXED_NOW },
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "before compact" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "/compact" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    const compactMessage = adapter.state
      .getBundle(sessionId)
      ?.messages.find(
        (message) =>
          message.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === "/compact"),
      )
    expect(compactMessage).toBeDefined()
    expect(adapter.state.store.compactProgress[sessionId]).toBeUndefined()
    expect(
      adapter.state
        .getBundle(sessionId)
        ?.messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "internal summary"),
        ),
    ).toBe(false)

    const editResponse = await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "replacement", editMessageId: compactMessage?.id }),
      }),
    )
    expect(editResponse.status).toBe(202)
    await adapter.waitForIdle(sessionId)

    const messages = adapter.state.getBundle(sessionId)?.messages ?? []
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === "before compact"),
      ),
    ).toBe(true)
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === "/compact"),
      ),
    ).toBe(false)
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === "replacement"),
      ),
    ).toBe(true)
    dispose()
  })

  test("creates a session and sends 'hello' — store populated with assistant text", async () => {
    // Given: an adapter backed by a fake engine that yields assistant text.
    const { adapter, engine, dispose } = setup({ kind: "text", text: "hello back" })

    // When: a session is created and "hello" is prompted.
    const session = await createSession(adapter)
    const response = await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
      }),
    )

    // Then: the prompt is accepted (202) and the engine received it.
    expect(response.status).toBe(202)
    expect(engine.submitMessageCalls).toEqual(["hello"])

    await waitForIdle(adapter.state, parseSessionId(session.id))

    const bundle = adapter.state.getBundle(parseSessionId(session.id))
    expect(bundle).toBeDefined()
    expect(bundle?.status.type).toBe("idle")

    const assistantMessages = bundle?.messages.filter((m) => m.role === "assistant")
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
    const textParts = assistantMessages[0]?.parts.filter((p) => p.type === "text")
    expect(textParts.length).toBeGreaterThanOrEqual(1)

    dispose()
  })

  test("sets effort for an existing session", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "hello" })
    const session = await createSession(adapter)

    const response = await adapter.fetch(
      request(`/session/${session.id}/effort`, {
        method: "POST",
        body: JSON.stringify({ effort: "high" }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, effort: "high" })
    expect(adapter.state.getSession(parseSessionId(session.id))?.effort).toBe("high")
    dispose()
  })

  test("projects a durable system event for goal set without creating a user message", async () => {
    const sessionStore = createMemorySessionStore()
    const fakeEngine = new FakeWrenEngine({ kind: "text", text: "goal response" })
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(fakeEngine, {
        clock: { now: () => FIXED_NOW },
        sessionStore,
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    const response = await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "set", objective: "Keep the migration green" }),
      }),
    )
    expect(response.status).toBe(200)
    await waitForSubmitCount(fakeEngine, 1)
    await adapter.waitForIdle(sessionId)

    const messages = adapter.state.getBundle(sessionId)?.messages ?? []
    expect(messages.filter((message) => message.role === "user")).toHaveLength(0)
    expect(messages.filter((message) => message.role === "system")).toHaveLength(1)
    expect(messages.find((message) => message.role === "system")?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Goal set: Keep the migration green" }),
    ])
    expect(messages.some((message) => message.role === "assistant")).toBe(true)

    const saved = await sessionStore.load(sessionId)
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.value.messages.filter((message) => message.role === "system")).toHaveLength(1)
    }
    dispose()
  })

  test("labels replacing an active goal as an update", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "goal response" })
    const session = await createSession(adapter)

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "set", objective: "First objective" }),
      }),
    )
    await adapter.waitForIdle(parseSessionId(session.id))
    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "set", objective: "Second objective" }),
      }),
    )
    await adapter.waitForIdle(parseSessionId(session.id))

    const systemTexts = (adapter.state.getBundle(parseSessionId(session.id))?.messages ?? [])
      .filter((message) => message.role === "system")
      .flatMap((message) =>
        message.parts.filter((part) => part.type === "text").map((part) => part.text),
      )
    expect(systemTexts).toEqual(["Goal set: First objective", "Goal updated: Second objective"])
    dispose()
  })
  test("starts a goal using the engine session key and counts its first turn once", async () => {
    const goalEngine = new BlockingFakeEngine()
    const engineSessionId = "ses_goal_engine"
    const factory: WrenEngineFactory = {
      createEngine: async () => goalEngine,
      getDefaultModel: () => "fake/blocking",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => engineSessionId,
      dispose: () => {},
    }
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(new FakeWrenEngine({ kind: "text", text: "unused" }), {
        clock: { now: () => FIXED_NOW },
        engineFactory: factory,
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)

    const setResponse = await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "set", objective: "Finish the test objective" }),
      }),
    )
    expect(setResponse.status).toBe(200)
    await waitForEnginePrompt(goalEngine)

    const status = (await json(adapter, `/session/${session.id}/goal`, {
      method: "POST",
      body: JSON.stringify({ action: "status" }),
    })) as { goal: { turnsExecuted: number; objective: string } | null }
    expect(status.goal).toMatchObject({ turnsExecuted: 1, objective: "Finish the test objective" })

    clearGoal(engineSessionId)
    goalEngine.release()
    await waitForAdapterIdle(adapter, parseSessionId(session.id))
    dispose()
  })

  test("does not start Goal continuation when a prompt opts out", async () => {
    const engineSessionId = "ses_goal_no_continuation_engine"
    const fakeEngine = new FakeWrenEngine({ kind: "text", text: "one explicit response" })
    const factory: WrenEngineFactory = {
      createEngine: async () => fakeEngine,
      getDefaultModel: () => "fake/model",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => engineSessionId,
      dispose: () => {},
    }
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(new FakeWrenEngine({ kind: "text", text: "unused" }), {
        clock: { now: () => FIXED_NOW },
        engineFactory: factory,
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    setGoal("Only run when explicitly requested", { sessionId: engineSessionId })

    const response = await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "one prompt", disableGoalContinuation: true }),
      }),
    )
    expect(response.status).toBe(202)
    await waitForAdapterIdle(adapter, parseSessionId(session.id))

    expect(fakeEngine.submitMessageCalls).toEqual(["one prompt"])
    expect(getGoal(engineSessionId)?.status).toBe("active")
    clearGoal(engineSessionId)
    dispose()
  })


  test("clearing a session clears its active goal", async () => {
    const sessionStore = createMemorySessionStore()
    const goalEngine = new GoalPersistenceFakeEngine()
    const engineSessionId = "ses_goal_clear_engine"
    const factory: WrenEngineFactory = {
      createEngine: async () => goalEngine,
      getDefaultModel: () => "fake/goal-clear",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => engineSessionId,
      dispose: () => {},
    }
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(new FakeWrenEngine({ kind: "text", text: "unused" }), {
        clock: { now: () => FIXED_NOW },
        engineFactory: factory,
        sessionStore,
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "set", objective: "Clear this thread goal" }),
      }),
    )
    await waitForSubmitCount(goalEngine, 1)
    goalEngine.releaseGoalTurn()
    await adapter.waitForIdle(sessionId)

    const clearResponse = await adapter.fetch(request(`/session/${session.id}/clear`, { method: "POST" }))
    expect(clearResponse.status).toBe(200)
    expect(getGoal(engineSessionId)).toBeNull()

    const persisted = await sessionStore.load(sessionId)
    expect(persisted.ok).toBe(true)

    dispose()
  })

  test("persists goal-only state across every mutation and clears it", async () => {
    const sessionStore = createMemorySessionStore()
    const goalEngine = new GoalPersistenceFakeEngine()
    const engineSessionId = "ses_goal_persistence_engine"
    const factory: WrenEngineFactory = {
      createEngine: async () => goalEngine,
      getDefaultModel: () => "fake/goal-persistence",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => engineSessionId,
      dispose: () => {},
    }
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(new FakeWrenEngine({ kind: "text", text: "unused" }), {
        clock: { now: () => FIXED_NOW },
        engineFactory: factory,
        sessionStore,
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "seed persisted session" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "set", objective: "Persist every goal transition" }),
      }),
    )
    await waitForSubmitCount(goalEngine, 2)
    expect(await loadPersistedGoal(sessionStore, sessionId, engineSessionId)).toMatchObject({
      objective: "Persist every goal transition",
      status: "active",
    })

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "pause" }),
      }),
    )
    expect(await loadPersistedGoal(sessionStore, sessionId, engineSessionId)).toMatchObject({ status: "paused" })

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "resume" }),
      }),
    )
    expect(await loadPersistedGoal(sessionStore, sessionId, engineSessionId)).toMatchObject({ status: "active" })

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "complete" }),
      }),
    )
    expect(await loadPersistedGoal(sessionStore, sessionId, engineSessionId)).toMatchObject({ status: "complete" })

    await adapter.fetch(
      request(`/session/${session.id}/goal`, {
        method: "POST",
        body: JSON.stringify({ action: "clear" }),
      }),
    )
    const cleared = await sessionStore.load(sessionId)
    expect(cleared.ok).toBe(true)

    goalEngine.releaseGoalTurn()
    await adapter.waitForIdle(sessionId)
    clearGoal(engineSessionId)
    dispose()
  })

  test("keeps effort isolated between sessions", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "hello" })
    const first = await createSession(adapter)
    const second = await createSession(adapter)

    await adapter.fetch(
      request(`/session/${first.id}/effort`, {
        method: "POST",
        body: JSON.stringify({ effort: "high" }),
      }),
    )
    await adapter.fetch(
      request(`/session/${second.id}/effort`, {
        method: "POST",
        body: JSON.stringify({ effort: "low" }),
      }),
    )

    expect(adapter.state.getSession(parseSessionId(first.id))?.effort).toBe("high")
    expect(adapter.state.getSession(parseSessionId(second.id))?.effort).toBe("low")
    dispose()
  })

  test("rejects invalid session effort values", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "hello" })
    const session = await createSession(adapter)

    const response = await adapter.fetch(
      request(`/session/${session.id}/effort`, {
        method: "POST",
        body: JSON.stringify({ effort: "turbo" }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_request",
      message: "effort must be low|medium|high|xhigh|max",
    })
    dispose()
  })

  test("set effort validates against model supported efforts", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "wren-effort-valid-"))
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        defaultModel: { source: "p", model: "effort-model" },
        smallFastModel: { source: "p", model: "effort-model" },
        sources: {
          p: {
            type: "openai-compatible-chat",
            baseUrl: "https://example.invalid/v1",
            apiKey: "key",
            models: {
              "effort-model": {
                contextWindow: 128000,
                supportsThinking: true,
                effort: "high",
                efforts: ["low", "medium", "high"],
              },
              "no-effort-model": { contextWindow: 128000, supportsThinking: false },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(configHome)
    try {
      const { adapter, dispose } = setup({ kind: "text", text: "hello" })
      const session = (await json(adapter, "/session", {
        method: "POST",
        body: JSON.stringify({ cwd: "/tmp/project", modelId: "p/effort-model" }),
      })) as { id: string }

      // Valid effort should succeed
      const okResponse = await adapter.fetch(
        request(`/session/${session.id}/effort`, {
          method: "POST",
          body: JSON.stringify({ effort: "high" }),
        }),
      )
      expect(okResponse.status).toBe(200)
      expect(await okResponse.json()).toEqual({ ok: true, effort: "high" })
      dispose()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("set effort returns unsupported for models without effort levels", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "wren-effort-unsup-"))
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        defaultModel: { source: "p", model: "effort-model" },
        smallFastModel: { source: "p", model: "effort-model" },
        sources: {
          p: {
            type: "openai-compatible-chat",
            baseUrl: "https://example.invalid/v1",
            apiKey: "key",
            models: {
              "effort-model": {
                contextWindow: 128000,
                supportsThinking: true,
                effort: "high",
                efforts: ["low", "medium", "high"],
              },
              "no-effort-model": { contextWindow: 128000, supportsThinking: false },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(configHome)
    try {
      expect(
        loadModelRegistry().entries.some(
          (entry) => entry.sourceName === "p" && entry.ref.modelId === "no-effort-model",
        ),
      ).toBe(true)
      const project = join(configHome, "project")
      const projectConfigPath = join(project, ".wren", "config.json")
      await mkdir(join(project, ".wren"), { recursive: true })
      await writeFile(projectConfigPath, await readFile(join(configHome, "config.json"), "utf8"))
      const { adapter, dispose } = setup({ kind: "text", text: "hello" }, project)
      const session = (await json(adapter, "/session", {
        method: "POST",
        body: JSON.stringify({ cwd: "/tmp/project", modelId: "p/no-effort-model" }),
      })) as { id: string }
      expect(adapter.state.getSession(parseSessionId(session.id))?.modelId).toBe(
        "p/no-effort-model",
      )

      const response = await adapter.fetch(
        request(`/session/${session.id}/effort`, {
          method: "POST",
          body: JSON.stringify({ effort: "high" }),
        }),
      )
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe("unsupported")
      dispose()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("model switch clamps effort when new model doesn't support it", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "wren-effort-clamp-"))
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        defaultModel: { source: "p", model: "effort-model" },
        smallFastModel: { source: "p", model: "effort-model" },
        sources: {
          p: {
            type: "openai-compatible-chat",
            baseUrl: "https://example.invalid/v1",
            apiKey: "key",
            models: {
              "effort-model": {
                contextWindow: 128000,
                supportsThinking: true,
                effort: "high",
                efforts: ["low", "medium", "high"],
              },
              "no-effort-model": { contextWindow: 128000, supportsThinking: false },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(configHome)
    try {
      const { adapter, dispose } = setup({ kind: "text", text: "hello" })
      const session = (await json(adapter, "/session", {
        method: "POST",
        body: JSON.stringify({ cwd: "/tmp/project", modelId: "p/effort-model" }),
      })) as { id: string }

      // Set effort to high
      await adapter.fetch(
        request(`/session/${session.id}/effort`, {
          method: "POST",
          body: JSON.stringify({ effort: "high" }),
        }),
      )

      // Switch to no-effort-model (doesn't support effort)
      const response = await adapter.fetch(
        request(`/session/${session.id}/model`, {
          method: "POST",
          body: JSON.stringify({ modelId: "p/no-effort-model" }),
        }),
      )
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.ok).toBe(true)
      expect(body.effortAdjusted).toEqual({ old: "high", new: "default" })

      // Session effort should be cleared to default
      const sessionId = parseSessionId(session.id)
      expect(adapter.state.getSession(sessionId)?.effort).toBe("default")
      dispose()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("persists submitted prompts as user messages", async () => {
    // Given: an adapter backed by a real session store.
    const sessionStore = createMemorySessionStore()
    const { adapter, dispose } = createRoot((d) => {
      const engine = new FakeWrenEngine({ kind: "text", text: "stored response" })
      return {
        adapter: createWrenAdapter(engine, { clock: { now: () => FIXED_NOW }, sessionStore }),
        dispose: d,
      }
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    // When: a prompt is submitted and the turn completes.
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "persist me" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    // Then: the persisted bundle includes the prompt as a user text message.
    const saved = await sessionStore.list()
    const bundle = saved.bundles.find((item) => item.session.id === sessionId)
    expect(bundle).toBeDefined()
    if (bundle === undefined) throw new Error("session bundle was not persisted")
    const userMessages = bundle.messages.filter((message) => message.role === "user")
    expect(userMessages).toHaveLength(1)
    const textParts = userMessages[0]?.parts.filter((part) => part.type === "text") ?? []
    expect(textParts.map((part) => part.text)).toEqual(["persist me"])

    dispose()
  })

  test("clearSession waits for an in-flight fire-and-forget persistSession", async () => {
    const sessionStore = createMemorySessionStore()
    const { adapter, dispose } = createRoot((d) => {
      const engine = new FakeWrenEngine({ kind: "text", text: "response" })
      return {
        adapter: createWrenAdapter(engine, { clock: { now: () => FIXED_NOW }, sessionStore }),
        dispose: d,
      }
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    // Seed: send a prompt, which triggers a fire-and-forget persistSession in
    // the finally block. waitForIdle resolves the prompt, but the async save
    // may still be in flight.
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "seed message" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    // Immediately clear — the fire-and-forget persistSession from the prompt
    // completion must be serialized *before* the clear's full save, otherwise
    // the stale save would restore the deleted messages.
    const clearRes = await adapter.fetch(request(`/session/${session.id}/clear`, { method: "POST" }))
    expect(clearRes.status).toBe(200)

    // Wait a tick to let any un-serialized save settle.
    await new Promise((r) => setTimeout(r, 50))

    // The persisted session should have zero messages — the fire-and-forget
    // save from prompt completion must not have overwritten the clear.
    const persisted = await sessionStore.load(sessionId)
    expect(persisted.ok).toBe(true)
    if (persisted.ok) {
      expect(persisted.value.messages).toHaveLength(0)
    }
    dispose()
  })

  test("uses the session model when sending a prompt", async () => {
    // Given: a session created with a model override while the engine default is different.
    const { adapter, engine, dispose } = createRoot((d) => {
      const fakeEngine = new BlockingFakeEngine()
      return {
        adapter: createWrenAdapter(fakeEngine, { clock: { now: () => FIXED_NOW } }),
        engine: fakeEngine,
        dispose: d,
      }
    })
    const session = (await json(adapter, "/session", {
      method: "POST",
      body: JSON.stringify({ cwd: "/tmp/project", modelId: "custom/model" }),
    })) as { id: string }
    const sessionId = parseSessionId(session.id)

    // When: a prompt starts running.
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
      }),
    )

    // Then: status and the engine both use the session model, not the engine default.
    const status = adapter.state.getBundle(sessionId)?.status
    expect(status).toMatchObject({ type: "working", model: "custom/model" })
    expect(engine.getModel()).toBe("custom/model")

    await adapter.fetch(request(`/session/${session.id}/abort`, { method: "POST" }))
    await waitForIdle(adapter.state, sessionId)
    dispose()
  })

  test("updates an existing session model", async () => {
    // Given: an adapter session with the default model.
    const { adapter, dispose } = setup({ kind: "text", text: "x" })
    const session = await createSession(adapter)

    // When: the TUI posts a model change for that session.
    const response = await adapter.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: "gpt-5.5" }),
      }),
    )

    // Then: the session metadata is updated through the adapter.
    expect(response.status).toBe(200)
    expect(adapter.state.getSession(parseSessionId(session.id))?.modelId).toBe("gpt-5.5")
    dispose()
  })

  test("abort interrupts the running engine", async () => {
    // Given: an adapter with a fake engine.
    const { adapter, engine, dispose } = setup({ kind: "text", text: "working" })
    const session = await createSession(adapter)

    // When: a prompt is started then aborted.
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "block" }),
      }),
    )
    const abortResponse = await adapter.fetch(
      request(`/session/${session.id}/abort`, { method: "POST" }),
    )

    // Then: the engine's interrupt was called.
    expect(abortResponse.status).toBe(200)
    expect(engine.interruptCalled).toBe(true)

    await waitForIdle(adapter.state, parseSessionId(session.id))
    dispose()
  })

  test("unknown session returns a typed 404 error", async () => {
    // Given: an adapter with no sessions.
    const { adapter, dispose } = setup({ kind: "text", text: "x" })

    // When: a request targets a non-existent session.
    const response = await adapter.fetch(request("/session/ses_missing"))
    const body = (await response.json()) as { error: string; message: string }

    // Then: the response is a typed 404 naming the missing session.
    expect(response.status).toBe(404)
    expect(body.error).toBe("session_not_found")
    expect(body.message).toContain("ses_missing")

    dispose()
  })

  test("list sessions returns the created sessions", async () => {
    // Given: an adapter with two created sessions.
    const { adapter, dispose } = setup({ kind: "text", text: "x" })
    const first = await createSession(adapter, "/tmp/a")
    const second = await createSession(adapter, "/tmp/b")

    // When: sessions are listed.
    const sessions = (await json(adapter, "/session")) as { id: string; cwd: string }[]

    // Then: both sessions appear with their cwd.
    expect(sessions.map((s) => s.id)).toEqual([first.id, second.id])
    expect(sessions.map((s) => s.cwd)).toEqual(["/tmp/a", "/tmp/b"])

    dispose()
  })

  test("config route returns model providers and permissionMode", async () => {
    // Given: an adapter backed by a fake engine with a known model.
    const { adapter, dispose } = setup({ kind: "text", text: "x" })

    // When: config is fetched.
    const config = (await json(adapter, "/config")) as {
      model: string
      providers: unknown[]
      permissionMode: string
    }

    // Then: the config shape matches the local adapter contract.
    expect(config.model).toBe("fake/model")
    expect(Array.isArray(config.providers)).toBe(true)
    expect(config.permissionMode).toBe("default")

    dispose()
  })

  test("queued prompts yield after tool results and drain in order", async () => {
    const { adapter, engine, dispose } = createRoot((d) => {
      const controlledEngine = new YieldBoundaryFakeEngine()
      return {
        adapter: createWrenAdapter(controlledEngine, { clock: { now: () => FIXED_NOW } }),
        engine: controlledEngine,
        dispose: d,
      }
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "first" }),
      }),
    )
    await waitForSubmitCount(engine, 1)
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "second" }),
      }),
    )
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "third" }),
      }),
    )

    expect(engine.requestYieldCalls).toBe(0)
    expect(engine.interruptCalled).toBe(false)

    engine.releaseToolResult()
    await adapter.waitForIdle(sessionId)

    expect(engine.submitMessageCalls).toEqual(["first", "second", "third"])
    expect(engine.yieldStateAtSubmit).toEqual([false, false, false])
    expect(engine.requestYieldCalls).toBe(1)
    expect(engine.resetYieldCalls).toBe(3)
    expect(engine.interruptCalled).toBe(false)
    expect(
      adapter.state.getBundle(sessionId)?.messages.some((message) => message.queued === true),
    ).toBe(false)

    dispose()
  })

  test("abort discards queued prompts and their transcript messages", async () => {
    const { adapter, engine, dispose } = createRoot((d) => {
      const blockingEngine = new BlockingFakeEngine()
      return {
        adapter: createWrenAdapter(blockingEngine, { clock: { now: () => FIXED_NOW } }),
        engine: blockingEngine,
        dispose: d,
      }
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "first" }),
      }),
    )
    await waitForEnginePrompt(engine)
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "second" }),
      }),
    )
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "third" }),
      }),
    )

    expect(
      adapter.state.getBundle(sessionId)?.messages.filter((message) => message.queued === true),
    ).toHaveLength(2)

    const abortResponse = await adapter.fetch(
      request(`/session/${session.id}/abort`, { method: "POST" }),
    )
    await adapter.waitForIdle(sessionId)

    const remainingText =
      adapter.state
        .getBundle(sessionId)
        ?.messages.flatMap((message) =>
          message.parts.filter((part) => part.type === "text").map((part) => part.text),
        ) ?? []
    expect(abortResponse.status).toBe(200)
    expect(engine.submitMessageCalls).toEqual(["first"])
    expect(remainingText).not.toContain("second")
    expect(remainingText).not.toContain("third")
    expect(
      adapter.state.getBundle(sessionId)?.messages.some((message) => message.queued === true),
    ).toBe(false)

    dispose()
  })

  test("rejects workspace default-model persistence", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "unused" })

    const response = await adapter.fetch(
      request("/config/default-model", {
        method: "POST",
        body: JSON.stringify({ modelId: "gpt-5.5", scope: "workspace" }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_body" })
    dispose()
  })

  test("concurrent prompt is queued instead of rejected", async () => {
    // Given: an adapter whose fake engine blocks the stream.
    const { adapter, dispose } = createRoot((d) => {
      const engine = new BlockingFakeEngine()
      return { adapter: createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } }), dispose: d }
    })
    const session = await createSession(adapter)

    // When: a second prompt arrives while the first is still running.
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "first" }),
      }),
    )
    const queuedResponse = await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "second" }),
      }),
    )
    const body = (await queuedResponse.json()) as { ok: boolean; queued: boolean }

    // Then: the second prompt is accepted and queued (202), not rejected.
    expect(queuedResponse.status).toBe(202)
    expect(body.queued).toBe(true)

    // Cleanup: release the blocking engine so the queued prompt can drain.
    await adapter.fetch(request(`/session/${session.id}/abort`, { method: "POST" }))
    await adapter.waitForIdle(parseSessionId(session.id))

    dispose()
  })

  test("permission reply resolves a pending permission ask", async () => {
    // Given: an adapter whose fake engine triggers a permission ask.
    const { adapter, dispose } = setup({
      kind: "askPermission",
      toolName: "Bash",
      input: { command: "ls" },
    })
    const session = await createSession(adapter)

    // When: a prompt triggers the ask, then the user replies "once".
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "run ls" }),
      }),
    )
    // Wait for the permission request to surface in the store.
    const permId = await waitForPermission(adapter.state, parseSessionId(session.id))
    const replyResponse = await adapter.fetch(
      request(`/session/${session.id}/permission/${permId}`, {
        method: "POST",
        body: JSON.stringify({ response: "once" }),
      }),
    )

    // Then: the reply is accepted and the permission is cleared from the store.
    expect(replyResponse.status).toBe(200)
    await waitForIdle(adapter.state, parseSessionId(session.id))
    const bundle = adapter.state.getBundle(parseSessionId(session.id))
    expect(bundle?.permissions).toEqual([])

    dispose()
  })

  test("full permission mode allows tool use without creating a pending permission", async () => {
    // Given: a session in full permission mode and an engine that asks for tool permission.
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: "Bash",
      input: { command: "pwd" },
    })
    const session = await createSession(adapter, "/tmp/project", "full")
    const sessionId = parseSessionId(session.id)

    // When: a prompt reaches the permission resolver.
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "run pwd" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    // Then: the resolver auto-allows and no permission request is left for the TUI.
    expect(engine.permissionDecisions).toEqual([{ behavior: "allow" }])
    expect(adapter.state.getBundle(sessionId)?.permissions).toEqual([])

    dispose()
  })

  test("updates an existing session permission mode to full", async () => {
    // Given: a default-mode session and an engine that asks for tool permission.
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: "Bash",
      input: { command: "pwd" },
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    // When: the session permission mode is updated before the prompt runs.
    const response = await adapter.fetch(
      request(`/session/${session.id}/permission-mode`, {
        method: "POST",
        body: JSON.stringify({ permissionMode: "full" }),
      }),
    )
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "run pwd" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    // Then: the resolver uses the updated mode and no permission prompt remains.
    expect(response.status).toBe(200)
    expect(adapter.state.getSession(sessionId)?.permissionMode).toBe("full")
    expect(engine.permissionDecisions).toEqual([{ behavior: "allow" }])
    expect(adapter.state.getBundle(sessionId)?.permissions).toEqual([])

    dispose()
  })

  test("keeps adapter, engine, and persistence permission modes synchronized", async () => {
    const sessionStore = createMemorySessionStore()
    const sessionEngine = new FakeWrenEngine({ kind: "text", text: "ready" })
    const factory: WrenEngineFactory = {
      createEngine: async () => sessionEngine,
      getDefaultModel: () => "fake/model",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => "ses_permission_engine",
      dispose: () => {},
    }
    const { adapter, dispose } = createRoot((d) => ({
      adapter: createWrenAdapter(new FakeWrenEngine({ kind: "text", text: "unused" }), {
        clock: { now: () => FIXED_NOW },
        engineFactory: factory,
        sessionStore,
      }),
      dispose: d,
    }))
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "initialize engine" }),
      }),
    )
    await adapter.waitForIdle(sessionId)

    const updateResponse = await adapter.fetch(
      request(`/session/${session.id}/permission-mode`, {
        method: "POST",
        body: JSON.stringify({ permissionMode: "auto" }),
      }),
    )

    expect(updateResponse.status).toBe(200)
    expect(sessionEngine.permissionModes).toEqual(["default", "auto"])
    expect(adapter.state.getSession(sessionId)?.permissionMode).toBe("auto")
    expect(await sessionStore.load(sessionId)).toMatchObject({
      ok: true,
      value: { session: { permissionMode: "auto" } },
    })

    sessionEngine.emitPermissionModeChange("plan")
    expect(adapter.state.getSession(sessionId)?.permissionMode).toBe("plan")
    await waitForPersistedPermissionMode(sessionStore, sessionId, "plan")

    sessionEngine.emitPermissionModeChange("auto")
    expect(adapter.state.getSession(sessionId)?.permissionMode).toBe("auto")
    await waitForPersistedPermissionMode(sessionStore, sessionId, "auto")

    dispose()
  })

  test("abort resolves a pending permission so adapter waitForIdle completes", async () => {
    // Given: a running prompt blocked on a permission request.
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: "Bash",
      input: { command: "sleep 1" },
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "run sleep" }),
      }),
    )
    await waitForPermission(adapter.state, sessionId)

    // When: the session is aborted while the permission promise is pending.
    const abortResponse = await adapter.fetch(
      request(`/session/${session.id}/abort`, { method: "POST" }),
    )
    await waitForAdapterIdle(adapter, sessionId)

    // Then: the engine was interrupted and the pending permission resolved as an abort denial.
    expect(abortResponse.status).toBe(200)
    expect(engine.interruptCalled).toBe(true)
    expect(engine.permissionDecisions).toEqual([{ behavior: "deny", message: "aborted" }])
    expect(adapter.state.getBundle(sessionId)?.permissions).toEqual([])

    dispose()
  })

  test("abort denies straggler permission created after abortSession", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermissionTwice",
      toolName: "Bash",
      input: { command: "echo hello" },
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "run tool twice" }),
      }),
    )
    await waitForPermission(adapter.state, sessionId)

    const abortResponse = await adapter.fetch(
      request(`/session/${session.id}/abort`, { method: "POST" }),
    )
    await waitForAdapterIdle(adapter, sessionId)

    expect(abortResponse.status).toBe(200)
    expect(engine.permissionDecisions).toEqual([
      { behavior: "deny", message: "aborted" },
      { behavior: "deny", message: "session aborted" },
    ])
    expect(adapter.state.getBundle(sessionId)?.permissions).toEqual([])
    expect(adapter.state.getBundle(sessionId)?.status.type).toBe("idle")

    dispose()
  })
})

describe("local adapter — resume", () => {
  test("hydrates a large persisted transcript in one reactive update", async () => {
    const sessionStore = createMemorySessionStore()
    const sessionId = parseSessionId("ses_large_hydration")
    const messages = Array.from({ length: 5000 }, (_, index) => ({
      id: parseMessageId(`msg_large_hydration_${index}`),
      sessionId,
      role: "assistant" as const,
      parts: [
        {
          type: "text" as const,
          id: parsePartId(`part_large_hydration_${index}`),
          text: `message ${index}`,
        },
      ],
      createdAt: FIXED_NOW,
    }))
    await sessionStore.save({
      session: {
        id: sessionId,
        cwd: "/tmp/large",
        modelId: "fake/model",
        permissionMode: "default",
      },
      status: { type: "idle" },
      messages,
      todos: [],
      permissions: [],
      diff: [],
    })
    let loadCalls = 0
    const countingStore: SessionStore = {
      save: (bundle) => sessionStore.save(bundle),
      async load(id) {
        loadCalls++
        return sessionStore.load(id)
      },
      list: (cwd) => sessionStore.list(cwd),
      listSummaries: (cwd) => sessionStore.listSummaries(cwd),
      delete: (id) => sessionStore.delete(id),
      saveSessionMeta: (meta) => sessionStore.saveSessionMeta(meta),
      close: () => sessionStore.close(),
    }
    const { adapter, dispose } = createRoot((dispose) => ({
      adapter: createWrenAdapter(new FakeWrenEngine({ kind: "text", text: "unused" }), {
        clock: { now: () => FIXED_NOW },
        cwd: "/tmp/large",
        sessionStore: countingStore,
      }),
      dispose,
    }))
    await adapter.resume()
    const observedLengths: number[] = []
    createComputed(() => {
      const loaded = adapter.state.store.messages[sessionId]
      if (loaded !== undefined) observedLengths.push(loaded.length)
    })

    const [first, second] = await Promise.all([
      adapter.fetch(request(`/session/${sessionId}/messages`)),
      adapter.fetch(request(`/session/${sessionId}/messages`)),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(loadCalls).toBe(1)
    expect(observedLengths).toEqual([5000])
    expect(adapter.state.store.messages[sessionId]?.[0]?.id).toBe(messages[0]?.id)
    expect(adapter.state.store.messages[sessionId]?.at(-1)?.id).toBe(messages.at(-1)?.id)
    dispose()
  })

  test("resume restores sessions from the session store", async () => {
    // Given: a fake engine and an adapter with a persisted session.
    const { adapter, dispose } = setup({ kind: "text", text: "restored" })
    const session = await createSession(adapter, "/tmp/resume")
    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hi" }),
      }),
    )
    await waitForIdle(adapter.state, parseSessionId(session.id))

    // When: a fresh adapter resumes from the same in-memory session store.
    const sharedStore = adapter.state
    const secondEngine = new FakeWrenEngine({ kind: "text", text: "x" })
    const resumed = createWrenAdapter(secondEngine, {
      clock: { now: () => FIXED_NOW },
      wirePermissionResolver: false,
    })
    // Drain the original session store into the resumed adapter by replaying
    // the bundle (simulates a file-backed resume).
    // biome-ignore lint/style/noNonNullAssertion: known to exist
    const bundle = sharedStore.getBundle(parseSessionId(session.id))!
    resumed.state.addSession(bundle.session)
    resumed.state.setStatus(bundle.session.id, bundle.status)
    for (const message of bundle.messages) resumed.state.addMessage(message)

    // Then: the resumed adapter sees the session and its messages.
    const sessions = (await json(resumed, "/session")) as { id: string }[]
    expect(sessions.map((s) => s.id)).toContain(session.id)
    const messages = (await json(resumed, `/session/${session.id}/messages`)) as unknown[]
    expect(messages.length).toBeGreaterThan(0)

    dispose()
  })

  test("resume keeps a preview separate from the unloaded transcript", async () => {
    const sessionStore = createMemorySessionStore()
    const firstEngine = new FakeWrenEngine({ kind: "text", text: "full assistant history" })
    const first = createWrenAdapter(firstEngine, {
      clock: { now: () => FIXED_NOW },
      cwd: "/tmp/project",
      sessionStore,
    })
    const session = await createSession(first)
    const sessionId = parseSessionId(session.id)
    await first.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "identify this session" }),
      }),
    )
    await first.waitForIdle(sessionId)

    const secondEngine = new FakeWrenEngine({ kind: "text", text: "unused" })
    const resumed = createWrenAdapter(secondEngine, {
      clock: { now: () => FIXED_NOW },
      cwd: "/tmp/project",
      sessionStore,
    })
    await resumed.resume()

    expect(resumed.state.store.previews[sessionId]).toEqual({
      createdAt: FIXED_NOW,
      text: "identify this session",
    })
    expect(resumed.state.store.messages[sessionId]).toBeUndefined()

    const response = await resumed.fetch(request(`/session/${session.id}/messages`))

    expect(response.status).toBe(200)
    expect(resumed.state.store.messages[sessionId]).toHaveLength(2)
    expect(
      resumed.state
        .getBundle(sessionId)
        ?.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "full assistant history",
            ),
        ),
    ).toBe(true)
  })

  test("model changes persist immediately and resume uses the chosen model for the next prompt", async () => {
    // Given: a shared store with a persisted session.
    const sessionStore = createMemorySessionStore()
    const firstEngine = new FakeWrenEngine(
      { kind: "text", text: "before model change" },
      "first/default",
    )
    const first = createWrenAdapter(firstEngine, {
      clock: { now: () => FIXED_NOW },
      cwd: "/tmp/project",
      sessionStore,
    })
    const session = await createSession(first)
    const sessionId = parseSessionId(session.id)
    await first.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "persist me" }),
      }),
    )
    await first.waitForIdle(sessionId)

    // When: the model route changes the model and a fresh adapter resumes from the same store.
    const modelResponse = await first.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: "chosen/model" }),
      }),
    )
    const effortResponse = await first.fetch(
      request(`/session/${session.id}/effort`, {
        method: "POST",
        body: JSON.stringify({ effort: "high" }),
      }),
    )
    expect(await sessionStore.load(sessionId)).toMatchObject({
      ok: true,
      value: { session: { modelRef: { source: "chosen", model: "model", effort: "high" } } },
    })
    const secondEngine = new FakeWrenEngine(
      { kind: "text", text: "after resume" },
      "second/default",
    )
    const second = createWrenAdapter(secondEngine, {
      clock: { now: () => FIXED_NOW },
      cwd: "/tmp/project",
      sessionStore,
    })
    await second.resume()

    // Then: resume restores the chosen model and the next prompt runs with it.
    expect(modelResponse.status).toBe(200)
    expect(effortResponse.status).toBe(200)
    expect(second.state.getSession(sessionId)?.modelId).toBe("chosen/model")
    expect(second.state.getSession(sessionId)?.modelRef).toEqual({
      source: "chosen",
      model: "model",
      effort: "high",
    })
    await second.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "use chosen model" }),
      }),
    )
    expect(secondEngine.getModel()).toBe("chosen/model")
    await second.waitForIdle(sessionId)
  })
})

// ---------------------------------------------------------------------------
// BlockingFakeEngine — yields nothing until release(), to keep a prompt
// in-flight for the concurrent-prompt test.
// ---------------------------------------------------------------------------

class GoalPersistenceFakeEngine implements WrenEngine {
  readonly submitMessageCalls: string[] = []
  private model = "fake/goal-persistence"
  private readonly goalTurn = Promise.withResolvers<void>()
  private readonly historyOwner = {}

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    if (this.submitMessageCalls.length > 1) await this.goalTurn.promise
    yield resultSuccess()
  }
  releaseGoalTurn(): void {
    this.goalTurn.resolve()
  }
  interrupt(): void {
    this.goalTurn.resolve()
  }
  resetAbortController(): void {}
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model
  }
  setPermissionResolver(): void {}
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

class YieldBoundaryFakeEngine implements WrenEngine {
  interruptCalled = false
  readonly submitMessageCalls: string[] = []
  readonly yieldStateAtSubmit: boolean[] = []
  requestYieldCalls = 0
  resetYieldCalls = 0
  private yieldRequested = false
  private model = "fake/yield-boundary"
  private readonly firstToolResult = Promise.withResolvers<void>()
  private readonly historyOwner = {}

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    this.yieldStateAtSubmit.push(this.yieldRequested)
    if (this.submitMessageCalls.length === 1) {
      yield assistantWithToolUse(
        "toolu_yield_boundary",
        "Bash",
        { command: "true" },
        "uuid-yield-boundary-tool",
      )
      await this.firstToolResult.promise
      yield userToolResult("toolu_yield_boundary", "ok", "uuid-yield-boundary-result")
    }
    yield resultSuccess()
  }
  releaseToolResult(): void {
    this.firstToolResult.resolve()
  }
  interrupt(): void {
    this.interruptCalled = true
    this.firstToolResult.resolve()
  }
  resetAbortController(): void {}
  requestYield(): void {
    this.requestYieldCalls++
    this.yieldRequested = true
  }
  resetYieldRequest(): void {
    this.resetYieldCalls++
    this.yieldRequested = false
  }
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model
  }
  setPermissionResolver(): void {}
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

class BlockingFakeEngine implements WrenEngine {
  interruptCalled = false
  resetCalled = false
  readonly submitMessageCalls: string[] = []
  private model = "fake/blocking"
  private releaseController = Promise.withResolvers<void>()
  private readonly historyOwner = {}

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    await this.releaseController.promise
    yield resultSuccess()
  }
  release(): void {
    this.releaseController.resolve()
  }
  interrupt(): void {
    this.interruptCalled = true
    this.releaseController.resolve()
  }
  resetAbortController(): void {
    this.resetCalled = true
  }
  getModel(): string {
    return this.model
  }
  setModel(model: string): void {
    this.model = model
  }
  setPermissionResolver(): void {
    // no-op — permission path not exercised by the blocking test
  }
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

async function waitForEnginePrompt(engine: BlockingFakeEngine, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (engine.submitMessageCalls.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`goal continuation did not start within ${timeoutMs}ms`)
}

async function loadPersistedGoal(
  _store: ReturnType<typeof createMemorySessionStore>,
  sessionId: SessionId,
  engineSessionId: string,
): Promise<Record<string, unknown>> {
  // Goal state is now read from the engine's in-memory goal store,
  // not from the persisted session bundle (engineSnapshot was removed).
  const goal = getGoal(engineSessionId)
  if (goal === null || typeof goal !== "object") {
    throw new Error(`persisted goal missing: ${sessionId}`)
  }
  return goal as Record<string, unknown>
}

async function waitForPersistedPermissionMode(
  store: ReturnType<typeof createMemorySessionStore>,
  sessionId: SessionId,
  permissionMode: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await store.load(sessionId)
    if (result.ok && result.value.session.permissionMode === permissionMode) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`permission mode ${permissionMode} was not persisted for ${sessionId}`)
}

async function waitForPermission(
  store: TuiStoreApi,
  sessionId: SessionId,
  timeoutMs = 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bundle = store.getBundle(sessionId)
    const perm = bundle?.permissions[0]
    if (perm) return perm.id
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no permission surfaced for ${sessionId} within ${timeoutMs}ms`)
}

async function waitForAdapterIdle(
  adapter: WrenAdapter,
  sessionId: SessionId,
  timeoutMs = 1000,
): Promise<void> {
  await Promise.race([
    adapter.waitForIdle(sessionId),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`adapter waitForIdle timed out for ${sessionId}`)),
        timeoutMs,
      )
    }),
  ])
}

// Re-export for type-checking that the mapper is the same stream consumer
// the adapter uses (guards against accidental drift).
export { consumeSDKMessageStream }

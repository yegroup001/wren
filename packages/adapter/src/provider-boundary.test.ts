import { describe, expect, test } from "bun:test"
import type { PermissionResolver, SDKMessage, WrenEngine } from "@wren/engine"
import { EngineHistorySnapshot } from "@wren/engine"
import { parseSessionId, type SessionId } from "@wren/protocol"
import { createMemorySessionStore } from "@wren/storage"
import { createRoot } from "solid-js"
import { createWrenAdapter, type WrenAdapter } from "./local-adapter"

const FIXED_NOW = "2026-07-10T00:00:00.000Z"
const INTERNAL_ORIGIN = "http://wren.internal"
const PROJECT_CWD = "/tmp/project"

function request(path: string, init?: RequestInit): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, init)
}

class CapturingEngine implements WrenEngine {
  readonly setModelCalls: string[] = []
  readonly submitMessageCalls: string[] = []
  private model = "initial/default"
  private readonly historyOwner = {}

  private gateArmed = false
  private gateResolve: (() => void) | null = null
  private gatePromise: Promise<void> = Promise.resolve()

  armGate(): void {
    this.gateArmed = true
    this.gatePromise = new Promise((r) => {
      this.gateResolve = r
    })
  }
  releaseGate(): void {
    this.gateArmed = false
    this.gateResolve?.()
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    yield {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "ses_test",
      tools: [],
      model: this.model,
      permissionMode: "default",
      uuid: "u1",
    } as SDKMessage
    yield {
      type: "assistant",
      message: { role: "assistant", id: "msg1", content: [{ type: "text", text: "ok" }] },
      uuid: "u2",
    } as SDKMessage
    if (this.gateArmed) await this.gatePromise
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: "end_turn",
      session_id: "ses_test",
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
    this.setModelCalls.push(model)
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

function setup(): { adapter: WrenAdapter; engine: CapturingEngine; dispose: () => void } {
  return createRoot((dispose) => {
    const engine = new CapturingEngine()
    const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })
    return { adapter, engine, dispose }
  })
}

async function createSession(adapter: WrenAdapter, modelId?: string): Promise<{ id: string }> {
  const body =
    modelId !== undefined
      ? JSON.stringify({ cwd: "/tmp/project", modelId })
      : JSON.stringify({ cwd: "/tmp/project" })
  const res = await adapter.fetch(request("/session", { method: "POST", body }))
  return (await res.json()) as { id: string }
}

async function waitForIdle(
  adapter: WrenAdapter,
  sessionId: SessionId,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bundle = adapter.state.getBundle(sessionId)
    if (bundle?.status.type === "idle") return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`session ${sessionId} did not reach idle`)
}

describe("Todo 20: provider boundary — model reaches request chain", () => {
  test("model change + next prompt → engine.setModel receives the selected model", async () => {
    const { adapter, engine, dispose } = setup()
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    const modelRes = await adapter.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: "gpt-5.5" }),
      }),
    )
    expect(modelRes.status).toBe(200)
    const modelBody = (await modelRes.json()) as {
      ok: boolean
      modelId: string
      appliesTo: string
      diagnostics: unknown
    }
    expect(modelBody.ok).toBe(true)
    expect(modelBody.modelId).toBe("gpt-5.5")
    expect(modelBody.appliesTo).toBe("current")
    expect(modelBody.diagnostics).toBeDefined()

    expect(engine.setModelCalls).toContain("gpt-5.5")

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
      }),
    )
    await waitForIdle(adapter, sessionId)

    expect(engine.getModel()).toBe("gpt-5.5")
    dispose()
  })

  test("model change during running prompt → appliesTo is next_turn, engine.setModel not called", async () => {
    const { adapter, engine, dispose } = setup()
    const session = await createSession(adapter, "first/model")
    const sessionId = parseSessionId(session.id)

    engine.setModelCalls.length = 0
    engine.armGate()

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "running" }),
      }),
    )
    await new Promise((r) => setTimeout(r, 10))

    const modelRes = await adapter.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: "next-turn/model" }),
      }),
    )
    const body = (await modelRes.json()) as { appliesTo: string }
    expect(body.appliesTo).toBe("next_turn")
    expect(engine.setModelCalls).not.toContain("next-turn/model")

    engine.releaseGate()
    await waitForIdle(adapter, sessionId)
    dispose()
  })

  test("model change response includes diagnostics with logicalModel", async () => {
    const { adapter, dispose } = setup()
    const session = await createSession(adapter)

    const res = await adapter.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: "anthropic/claude-sonnet-4-5" }),
      }),
    )
    const body = (await res.json()) as {
      ok: boolean
      modelId: string
      appliesTo: string
      diagnostics: { logicalModel: string; providerId: unknown; envOverrides: unknown[] }
    }

    expect(body.diagnostics.logicalModel).toBe("anthropic/claude-sonnet-4-5")
    expect(Array.isArray(body.diagnostics.envOverrides)).toBe(true)
    dispose()
  })

  test("nested-slash model ID is preserved through the full chain", async () => {
    const { adapter, engine, dispose } = setup()
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    const nestedId = "openrouter/anthropic/claude-sonnet"
    await adapter.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: nestedId }),
      }),
    )

    expect(adapter.state.getSession(sessionId)?.modelId).toBe(nestedId)
    expect(engine.setModelCalls).toContain(nestedId)
    expect(engine.getModel()).toBe(nestedId)
    dispose()
  })

  test("invalid model body returns error status", async () => {
    const { adapter, dispose } = setup()
    const session = await createSession(adapter)

    const res = await adapter.fetch(
      request(`/session/${session.id}/model`, {
        method: "POST",
        body: JSON.stringify({ modelId: "" }),
      }),
    )
    expect(res.status).toBe(400)
    dispose()
  })

  test("/model test probe returns diagnostics without mutating session model", async () => {
    const { adapter, engine, dispose } = setup()
    const session = await createSession(adapter)

    const res = await adapter.fetch(
      request(`/session/${session.id}/model/test`, {
        method: "POST",
        body: JSON.stringify({ modelId: "probe/model" }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      modelId: string
      effectiveModelId: string
      diagnostics: unknown
    }
    expect(body.ok).toBe(true)
    expect(body.modelId).toBe("probe/model")
    expect(body.effectiveModelId).toBe("probe/model")
    expect(body.diagnostics).toBeDefined()

    const beforeProbe = engine.getModel()
    expect(beforeProbe).not.toBe("probe/model")
    dispose()
  })
})

describe("Todo 26: config migration and resume backward compatibility", () => {
  test("old session with only modelId string resumes with correct model", async () => {
    const sessionStore = createMemorySessionStore()

    const oldBundle = {
      session: {
        id: parseSessionId("ses_old_format"),
        cwd: PROJECT_CWD,
        modelId: "glm-5.2",
        permissionMode: "default",
      },
      status: { type: "idle" as const },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    }
    await sessionStore.save(oldBundle)

    const engine = new CapturingEngine()
    const adapter = createWrenAdapter(engine, {
      clock: { now: () => FIXED_NOW },
      cwd: PROJECT_CWD,
      sessionStore,
      wirePermissionResolver: false,
    })
    await adapter.resume()

    const sessions = await adapter.fetch(request("/session"))
    const list = (await sessions.json()) as { id: string; modelId: string }[]
    expect(list).toHaveLength(1)
    expect(list[0]?.modelId).toBe("glm-5.2")

    expect(engine.getModel()).toBe("glm-5.2")
  })

  test("multi-session resume: resume session A after B → engine has A's model not B's", async () => {
    const sessionStore = createMemorySessionStore()

    await sessionStore.save({
      session: {
        id: parseSessionId("ses_A"),
        cwd: PROJECT_CWD,
        modelId: "model-A",
        permissionMode: "default",
      },
      status: { type: "idle" },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    })
    await sessionStore.save({
      session: {
        id: parseSessionId("ses_B"),
        cwd: PROJECT_CWD,
        modelId: "model-B",
        permissionMode: "default",
      },
      status: { type: "idle" },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    })

    const engine = new CapturingEngine()
    const adapter = createWrenAdapter(engine, {
      clock: { now: () => FIXED_NOW },
      cwd: PROJECT_CWD,
      sessionStore,
      wirePermissionResolver: false,
    })
    await adapter.resume()

    const sessions = await adapter.fetch(request("/session"))
    const list = (await sessions.json()) as { id: string; modelId: string }[]
    expect(list).toHaveLength(2)

    expect(list[0]?.modelId).toBe("model-B")
    expect(engine.getModel()).toBe("model-B")

    const aResponse = await adapter.fetch(request("/session/ses_A"))
    const aSession = (await aResponse.json()) as { modelId: string }
    expect(aSession.modelId).toBe("model-A")
  })

  test("missing modelSelection field does not crash resume", async () => {
    const sessionStore = createMemorySessionStore()

    await sessionStore.save({
      session: {
        id: parseSessionId("ses_minimal"),
        cwd: PROJECT_CWD,
        modelId: "glm-5.2",
        permissionMode: "default",
      },
      status: { type: "idle" },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    })

    const engine = new CapturingEngine()
    const adapter = createWrenAdapter(engine, {
      clock: { now: () => FIXED_NOW },
      cwd: PROJECT_CWD,
      sessionStore,
      wirePermissionResolver: false,
    })

    await expect(adapter.resume()).resolves.toBeUndefined()

    const res = await adapter.fetch(request("/session/ses_minimal"))
    expect(res.status).toBe(200)
  })

  test("resume sets engine model to last resumed session's model", async () => {
    const sessionStore = createMemorySessionStore()
    const engine = new CapturingEngine()

    await sessionStore.save({
      session: {
        id: parseSessionId("ses_first"),
        cwd: PROJECT_CWD,
        modelId: "first-model",
        permissionMode: "default",
      },
      status: { type: "idle" },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    })
    await sessionStore.save({
      session: {
        id: parseSessionId("ses_second"),
        cwd: PROJECT_CWD,
        modelId: "second-model",
        permissionMode: "default",
      },
      status: { type: "idle" },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    })

    const adapter = createWrenAdapter(engine, {
      clock: { now: () => FIXED_NOW },
      cwd: PROJECT_CWD,
      sessionStore,
      wirePermissionResolver: false,
    })

    engine.setModelCalls.length = 0
    await adapter.resume()

    expect(engine.setModelCalls).toContain("second-model")
    expect(engine.getModel()).toBe("second-model")
  })
})

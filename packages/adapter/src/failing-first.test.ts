import { describe, expect, test } from "bun:test"
import type { PermissionResolver, SDKMessage, WrenEngine, WrenEngineFactory } from "@wren/engine"
import { EngineHistorySnapshot } from "@wren/engine"
import { parseSessionId, type SessionId } from "@wren/protocol"
import { createMemorySessionStore } from "@wren/storage"
import { createRoot } from "solid-js"
import { createWrenAdapter, type WrenAdapter } from "./local-adapter"
import { consumeSDKMessageStream } from "./message-mapper"
import { createTuiStore } from "./store"

// ---------------------------------------------------------------------------
// Failing-first tests for 9 verified adapter defects.
// Each test MUST fail for the correct reason (the bug exists).
// After Wave 2 fixes, these tests will turn green.
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-07-11T00:00:00.000Z"
const INTERNAL_ORIGIN = "http://wren.internal"
const PROJECT_CWD = "/tmp/project"

function request(path: string, init?: RequestInit): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, init)
}

// --- Stateful fake engine that tracks cross-session contamination ---

class StatefulFakeEngine implements WrenEngine {
  readonly submitMessageCalls: string[] = []
  readonly allPrompts: string[] = []
  interruptCalled = false
  resetCalled = false
  private model: string
  private readonly historyOwner = {}

  constructor(model = "fake/model") {
    this.model = model
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    this.allPrompts.push(prompt)
    yield {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "ses_fake",
      tools: [],
      model: this.model,
      permissionMode: "default",
      uuid: "u1",
    } as SDKMessage
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        id: "msg1",
        content: [{ type: "text", text: `response to: ${prompt}` }],
      },
      uuid: "u2",
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

async function waitForIdle(
  adapter: WrenAdapter,
  sessionId: SessionId,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bundle = adapter.state.getBundle(sessionId)
    if (bundle?.status.type === "idle") return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`session ${sessionId} did not reach idle within ${timeoutMs}ms`)
}

// ===========================================================================
// Defect 1: Singleton QueryEngine cross-session contamination
// ===========================================================================

describe("failing-first: singleton engine cross-session contamination", () => {
  test("session B should not see session A's prompt history", async () => {
    await createRoot(async (dispose) => {
      const allEngines: StatefulFakeEngine[] = []
      const fakeFactory: WrenEngineFactory = {
        createEngine: async (_sessionId: string) => {
          const engine = new StatefulFakeEngine()
          allEngines.push(engine)
          return engine
        },
        getDefaultModel: () => "fake/model",
        getCommands: () => [],
        getAgents: () => [],
        dispose: () => {},
      }
      const adapter = createWrenAdapter(allEngines[0] ?? new StatefulFakeEngine(), {
        clock: { now: () => FIXED_NOW },
        engineFactory: fakeFactory,
      })

      const resA = await adapter.fetch(
        request("/session", {
          method: "POST",
          body: JSON.stringify({ cwd: "/tmp/a" }),
        }),
      )
      const sessionA = (await resA.json()) as { id: string }
      await adapter.fetch(
        request(`/session/${sessionA.id}/message`, {
          method: "POST",
          body: JSON.stringify({ prompt: "A secret: the password is swordfish" }),
        }),
      )
      await waitForIdle(adapter, parseSessionId(sessionA.id))

      const resB = await adapter.fetch(
        request("/session", {
          method: "POST",
          body: JSON.stringify({ cwd: "/tmp/b" }),
        }),
      )
      const sessionB = (await resB.json()) as { id: string }
      await adapter.fetch(
        request(`/session/${sessionB.id}/message`, {
          method: "POST",
          body: JSON.stringify({ prompt: "What was the prior user text?" }),
        }),
      )
      await waitForIdle(adapter, parseSessionId(sessionB.id))

      expect(allEngines.length).toBeGreaterThanOrEqual(2)
      const engineB = allEngines[1]
      expect(engineB?.submitMessageCalls).not.toContain("A secret: the password is swordfish")

      dispose()
    })
  })
})

// ===========================================================================
// Defect 2: Idle abort poisons the next turn
// ===========================================================================

describe("failing-first: idle abort poisons next turn", () => {
  test("abort while idle should not prevent the next prompt from running", async () => {
    await createRoot(async (dispose) => {
      const engine = new StatefulFakeEngine()
      const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })

      const res = await adapter.fetch(
        request("/session", {
          method: "POST",
          body: JSON.stringify({ cwd: "/tmp" }),
        }),
      )
      const session = (await res.json()) as { id: string }
      const sid = parseSessionId(session.id)

      // Abort while idle (no prompt running)
      await adapter.fetch(request(`/session/${sid}/abort`, { method: "POST" }))

      // Now send a prompt — it should work, not be poisoned by the aborted signal
      await adapter.fetch(
        request(`/session/${sid}/message`, {
          method: "POST",
          body: JSON.stringify({ prompt: "hello" }),
        }),
      )

      // BUG: engine.interrupt() was called during idle abort, but
      // resetAbortController() was NOT called until runPrompt's finally block.
      // So the next submitMessage receives an already-aborted signal.
      // After fix: idle abort should call resetAbortController() after interrupt().
      expect(engine.submitMessageCalls).toContain("hello")
      expect(engine.resetCalled).toBe(true)

      dispose()
    })
  })
})

// ===========================================================================
// Defect 3: Unsorted --continue selection
// ===========================================================================

describe("failing-first: unsorted --continue selection", () => {
  test("--continue should select the most recently updated session", async () => {
    await createRoot(async (dispose) => {
      const sessionStore = createMemorySessionStore()

      // Save an "old" session first
      await sessionStore.save({
        session: {
          id: parseSessionId("ses_old"),
          cwd: PROJECT_CWD,
          modelId: "old-model",
          permissionMode: "default",
        },
        status: { type: "idle" },
        messages: [],
        todos: [],
        permissions: [],
        diff: [],
      })

      // Save a "new" session second
      await sessionStore.save({
        session: {
          id: parseSessionId("ses_new"),
          cwd: PROJECT_CWD,
          modelId: "new-model",
          permissionMode: "default",
        },
        status: { type: "idle" },
        messages: [],
        todos: [],
        permissions: [],
        diff: [],
      })

      const engine = new StatefulFakeEngine()
      const adapter = createWrenAdapter(engine, {
        clock: { now: () => FIXED_NOW },
        cwd: PROJECT_CWD,
        sessionStore,
        wirePermissionResolver: false,
      })
      await adapter.resume()

      const res = await adapter.fetch(request("/session"))
      const sessions = (await res.json()) as { id: string }[]

      expect(sessions[0]?.id).toBe("ses_new")

      dispose()
    })
  })
})

// ===========================================================================
// Defect 4: Async deletion race
// ===========================================================================

describe("failing-first: async deletion race", () => {
  test("DELETE response should not resolve before storage deletion completes", async () => {
    await createRoot(async (dispose) => {
      let deleteResolved = false
      const sessionStore = createMemorySessionStore()
      const originalDelete = sessionStore.delete.bind(sessionStore)
      sessionStore.delete = async (id: string) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        deleteResolved = true
        return originalDelete(id)
      }

      const engine = new StatefulFakeEngine()
      const adapter = createWrenAdapter(engine, {
        clock: { now: () => FIXED_NOW },
        sessionStore,
      })

      const res = await adapter.fetch(
        request("/session", {
          method: "POST",
          body: JSON.stringify({ cwd: "/tmp" }),
        }),
      )
      const session = (await res.json()) as { id: string }

      await adapter.fetch(request(`/session/${session.id}`, { method: "DELETE" }))

      // BUG: adapter uses `void sessionStore.delete()` so the response resolves
      // before the storage deletion completes. deleteResolved should be true
      // when DELETE returns.
      // After fix: adapter should `await sessionStore.delete()`.
      expect(deleteResolved).toBe(true)

      dispose()
    })
  })
})

// ===========================================================================
// Defect 5: Impossible working status after resume
// ===========================================================================

describe("failing-first: impossible working status after resume", () => {
  test("persisted working status should be normalized to idle on resume", async () => {
    await createRoot(async (dispose) => {
      const sessionStore = createMemorySessionStore()

      await sessionStore.save({
        session: {
          id: parseSessionId("ses_working"),
          cwd: PROJECT_CWD,
          modelId: "fake/model",
          permissionMode: "default",
        },
        status: {
          type: "working",
          model: "fake/model",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          },
          costUsd: 0,
        },
        messages: [],
        todos: [],
        permissions: [],
        diff: [],
      })

      const engine = new StatefulFakeEngine()
      const adapter = createWrenAdapter(engine, {
        clock: { now: () => FIXED_NOW },
        cwd: PROJECT_CWD,
        sessionStore,
        wirePermissionResolver: false,
      })
      await adapter.resume()

      const bundle = adapter.state.getBundle(parseSessionId("ses_working"))

      // BUG: restoreBundle restores the persisted "working" status verbatim,
      // so the TUI shows a spinner forever with no running prompt.
      // After fix: resume should normalize working/retry/compacting to idle.
      expect(bundle?.status.type).toBe("idle")

      dispose()
    })
  })
})

// ===========================================================================
// Defect 6: Result errors swallowed
// ===========================================================================

describe("failing-first: result errors swallowed", () => {
  test("result with is_error=true should create an error message in the store", async () => {
    const sessionId = parseSessionId("ses_test")
    createRoot((dispose) => {
      const store = createTuiStore()
      store.addSession({
        id: sessionId,
        cwd: "/tmp",
        modelId: "fake/model",
        permissionMode: "default",
      })

      const errorResult: SDKMessage = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [{ message: "Something went wrong" }],
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: "error",
        session_id: "ses_test",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "",
      } as SDKMessage

      async function* stream(): AsyncGenerator<SDKMessage, void, unknown> {
        yield errorResult
      }

      consumeSDKMessageStream(stream(), {
        clock: { now: () => FIXED_NOW },
        sessionId,
        store,
      }).then(() => {
        const bundle = store.getBundle(sessionId)
        const hasError = bundle?.messages.some(
          (m) =>
            m.error !== undefined ||
            m.parts.some((p) => p.type === "text" && p.text.includes("Something went wrong")),
        )

        // BUG: mapResultMessage ignores is_error and errors, only sets idle.
        // After fix: result with is_error should create an assistant error message.
        expect(hasError).toBe(true)

        dispose()
      })
    })
  })
})

// ===========================================================================
// Defect 7: Partial usage ignored during streaming
// ===========================================================================

describe("failing-first: partial usage ignored during streaming", () => {
  test("message_delta with usage should update working status before final result", async () => {
    const sessionId = parseSessionId("ses_test")
    createRoot((dispose) => {
      const store = createTuiStore()
      store.addSession({
        id: sessionId,
        cwd: "/tmp",
        modelId: "fake/model",
        permissionMode: "default",
      })

      const systemInit: SDKMessage = {
        type: "system",
        subtype: "init",
        cwd: "/tmp",
        session_id: "ses_test",
        tools: [],
        model: "fake/model",
        permissionMode: "default",
        uuid: "u1",
      } as SDKMessage

      const streamStart: SDKMessage = {
        type: "stream_event",
        event: { type: "message_start" },
      } as SDKMessage

      const messageDeltaWithUsage: SDKMessage = {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: null },
          usage: { input_tokens: 10, output_tokens: 50 },
        },
      } as SDKMessage

      async function* stream(): AsyncGenerator<SDKMessage, void, unknown> {
        yield systemInit
        yield streamStart
        yield messageDeltaWithUsage
        // Don't yield result yet — we want to check working status mid-stream
      }

      consumeSDKMessageStream(stream(), {
        clock: { now: () => FIXED_NOW },
        sessionId,
        store,
      }).then(() => {
        const bundle = store.getBundle(sessionId)
        const status = bundle?.status

        // BUG: mapStreamEvent ignores message_delta, so usage stays at 0.
        // After fix: message_delta usage should update working status.
        expect(status?.type).toBe("working")
        if (status?.type === "working") {
          expect(status.usage.outputTokens).toBe(50)
        }

        dispose()
      })
    })
  })
})

// ===========================================================================
// Defect 8: Premature plan-mode transitions
// ===========================================================================

describe("failing-first: premature plan-mode transitions", () => {
  test("EnterPlanMode tool_use alone should not change permission mode", async () => {
    const sessionId = parseSessionId("ses_test")
    createRoot((dispose) => {
      const store = createTuiStore()
      store.addSession({
        id: sessionId,
        cwd: "/tmp",
        modelId: "fake/model",
        permissionMode: "default",
      })

      const assistantWithPlanTool: SDKMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_plan",
          content: [{ type: "tool_use", id: "tu_1", name: "EnterPlanMode", input: {} }],
        },
        uuid: "u2",
      } as SDKMessage

      async function* stream(): AsyncGenerator<SDKMessage, void, unknown> {
        yield {
          type: "system",
          subtype: "init",
          cwd: "/tmp",
          session_id: "ses_test",
          tools: [],
          model: "fake/model",
          permissionMode: "default",
          uuid: "u1",
        } as SDKMessage
        yield assistantWithPlanTool
        // No tool_result follows — the tool_use is still "running"
      }

      consumeSDKMessageStream(stream(), {
        clock: { now: () => FIXED_NOW },
        sessionId,
        store,
      }).then(() => {
        const bundle = store.getBundle(sessionId)

        // BUG: extractPermissionModeChanges fires on tool_use creation
        // (status "running"), changing mode to "plan" before tool completes.
        // After fix: mode should only change when tool_use status is "completed".
        expect(bundle?.session.permissionMode).toBe("default")

        dispose()
      })
    })
  })
})

// ===========================================================================
// Defect 9: Malformed payload escapes fetch as thrown error
// ===========================================================================

describe("failing-first: malformed payload escapes fetch as thrown error", () => {
  test("POST /session/:id/model with empty modelId should return 400, not throw", async () => {
    await createRoot(async (dispose) => {
      const engine = new StatefulFakeEngine()
      const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })

      const res = await adapter.fetch(
        request("/session", {
          method: "POST",
          body: JSON.stringify({ cwd: "/tmp" }),
        }),
      )
      const session = (await res.json()) as { id: string }

      // BUG: parseModelBody throws AdapterPayloadError which escapes fetch()
      // as a rejected promise instead of returning a 400 Response.
      // After fix: fetch() should catch AdapterPayloadError and return 400 JSON.
      const modelResponse = await adapter.fetch(
        request(`/session/${session.id}/model`, {
          method: "POST",
          body: JSON.stringify({ modelId: "" }),
        }),
      )

      expect(modelResponse.status).toBe(400)

      dispose()
    })
  })
})

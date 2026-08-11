import { beforeAll, describe, expect, test } from "bun:test"
import type { PermissionResolver, SDKMessage, WrenEngine } from "@wren/engine"
import {
  createWrenEngine,
  EngineHistorySnapshot,
  getAllBaseTools,
  setConfigForTests,
} from "@wren/engine"
import { parseSessionId, type SessionId } from "@wren/protocol"
import { createRoot } from "solid-js"
import { createWrenAdapter, type WrenAdapter } from "./local-adapter"
import type { TuiStoreApi } from "./store"

beforeAll(() => {
  setConfigForTests({
    defaultModel: { source: "default", model: "gpt-5.5" },
    smallFastModel: { source: "default", model: "gpt-5.5" },
    sources: {
      default: {
        type: "openai-compatible-chat",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key-not-real",
        models: {
          "gpt-5.5": { contextWindow: 128000, supportsThinking: false },
        },
      },
    },
  })
  process.env.OPENAI_API_KEY = "test-key-not-real"
  process.env.OPENAI_BASE_URL = "https://example.invalid/v1"
  process.env.WREN_USE_OPENAI = "1"
})

const FIXED_NOW = "2026-07-08T00:00:00.000Z"
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion"

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

type FakeBehavior =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "askPermission"; readonly toolName: string; readonly input: unknown }

type PermissionDecision = Awaited<ReturnType<PermissionResolver>>

class FakeWrenEngine implements WrenEngine {
  readonly submitMessageCalls: string[] = []
  readonly permissionDecisions: PermissionDecision[] = []
  interruptCalled = false
  resetCalled = false
  private resolver: PermissionResolver | null = null
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
    if (this.behavior.kind === "askPermission") {
      if (this.resolver !== null) {
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

function setup(behavior: FakeBehavior): {
  adapter: WrenAdapter
  engine: FakeWrenEngine
  dispose: () => void
} {
  return createRoot((dispose) => {
    const engine = new FakeWrenEngine(behavior)
    const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW } })
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

async function waitForQuestion(
  store: TuiStoreApi,
  sessionId: SessionId,
  timeoutMs = 1000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bundle = store.getBundle(sessionId)
    const question = bundle?.questions[0]
    if (question) return question.id
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no question surfaced for ${sessionId} within ${timeoutMs}ms`)
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

const SINGLE_QUESTION_INPUT = {
  questions: [
    {
      question: "Which library?",
      header: "Library",
      options: [
        { label: "React", description: "React library" },
        { label: "Vue", description: "Vue library" },
      ],
      multiSelect: false,
    },
  ],
}

const MULTI_QUESTION_INPUT = {
  questions: [
    {
      question: "Which framework?",
      header: "Framework",
      options: [
        { label: "React", description: "React" },
        { label: "Vue", description: "Vue" },
      ],
      multiSelect: false,
    },
    {
      question: "Which styling?",
      header: "Styling",
      options: [
        { label: "CSS", description: "Plain CSS" },
        { label: "Tailwind", description: "Tailwind CSS" },
      ],
      multiSelect: false,
    },
  ],
}

describe("AskUserQuestionTool — tool registration", () => {
  test("tool passes isEnabled() and appears in getAllBaseTools", () => {
    const tools = getAllBaseTools()
    const tool = tools.find((t) => t.name === ASK_USER_QUESTION_TOOL_NAME)
    expect(tool).toBeDefined()
    expect(tool?.isEnabled()).toBe(true)
  })

  test("real engine instantiation includes AskUserQuestion in the tool pool", async () => {
    const engine = await createWrenEngine({
      canUseTool: async () => ({ behavior: "allow" }),
    })
    expect(typeof engine.submitMessage).toBe("function")
  })
})

describe("local adapter — AskUserQuestion question bridge", () => {
  test("AskUserQuestion creates a question in the store", async () => {
    const { adapter, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: SINGLE_QUESTION_INPUT,
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )

    await waitForQuestion(adapter.state, sessionId)
    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle?.questions).toHaveLength(1)
    expect(bundle?.questions[0]?.title).toBe("Which library?")
    expect(bundle?.questions[0]?.options.map((o) => o.label)).toEqual(["React", "Vue"])

    await adapter.fetch(request(`/session/${session.id}/abort`, { method: "POST" }))
    await waitForIdle(adapter.state, sessionId)
    dispose()
  })

  test("AskUserQuestion surfaces a question even in auto permission mode", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: SINGLE_QUESTION_INPUT,
    })
    const session = await createSession(adapter, "/tmp/project", "auto")
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )

    const qId = await waitForQuestion(adapter.state, sessionId)
    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle?.questions).toHaveLength(1)
    expect(bundle?.questions[0]?.title).toBe("Which library?")

    // Reply to the question — the resolver should get the answers
    const replyRes = await adapter.fetch(
      request(`/session/${session.id}/question/${qId}`, {
        method: "POST",
        body: JSON.stringify({ answers: ["Vue"] }),
      }),
    )
    expect(replyRes.status).toBe(200)

    await waitForIdle(adapter.state, sessionId)
    expect(engine.permissionDecisions).toHaveLength(1)
    expect(engine.permissionDecisions[0]).toMatchObject({ behavior: "allow" })
    dispose()
  })

  test("POST reply with an answer resolves the question and allows the tool", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: SINGLE_QUESTION_INPUT,
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )
    const qId = await waitForQuestion(adapter.state, sessionId)

    const replyResponse = await adapter.fetch(
      request(`/session/${session.id}/question/${qId}`, {
        method: "POST",
        body: JSON.stringify({ answers: ["React"] }),
      }),
    )
    expect(replyResponse.status).toBe(200)

    await waitForIdle(adapter.state, sessionId)

    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle?.questions).toEqual([])
    expect(engine.permissionDecisions).toHaveLength(1)
    const decision = engine.permissionDecisions[0] as {
      behavior: string
      updatedInput?: { answers?: Record<string, string> }
    }
    expect(decision.behavior).toBe("allow")
    expect(decision.updatedInput?.answers).toEqual({ "Which library?": "React" })

    dispose()
  })

  test("POST reply preserves every answer for a multi-select question", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: {
        questions: [{ ...(SINGLE_QUESTION_INPUT.questions[0] ?? {}), multiSelect: true }],
      },
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )
    const questionId = await waitForQuestion(adapter.state, sessionId)

    const response = await adapter.fetch(
      request(`/session/${session.id}/question/${questionId}`, {
        method: "POST",
        body: JSON.stringify({ answers: ["React", "Vue"] }),
      }),
    )

    expect(response.status).toBe(200)
    await waitForIdle(adapter.state, sessionId)
    const decision = engine.permissionDecisions[0] as {
      readonly updatedInput?: { readonly answers?: Record<string, string> }
    }
    expect(decision.updatedInput?.answers).toEqual({ "Which library?": "React, Vue" })
    dispose()
  })

  test("reject reply denies the tool call", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: SINGLE_QUESTION_INPUT,
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )
    const qId = await waitForQuestion(adapter.state, sessionId)

    const replyResponse = await adapter.fetch(
      request(`/session/${session.id}/question/${qId}`, {
        method: "POST",
        body: JSON.stringify({ answers: [], rejected: true }),
      }),
    )
    expect(replyResponse.status).toBe(200)

    await waitForIdle(adapter.state, sessionId)

    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle?.questions).toEqual([])
    expect(engine.permissionDecisions).toHaveLength(1)
    const decision = engine.permissionDecisions[0] as { behavior: string; message?: string }
    expect(decision.behavior).toBe("deny")
    expect(decision.message).toBe("user declined to answer")

    dispose()
  })

  test("multiple questions are answered sequentially and collected", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: MULTI_QUESTION_INPUT,
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )

    const firstQId = await waitForQuestion(adapter.state, sessionId)
    expect(adapter.state.getBundle(sessionId)?.questions).toHaveLength(2)

    await adapter.fetch(
      request(`/session/${session.id}/question/${firstQId}`, {
        method: "POST",
        body: JSON.stringify({ answers: ["React"] }),
      }),
    )

    const secondQId = await waitForQuestion(adapter.state, sessionId)
    expect(secondQId).not.toBe(firstQId)
    expect(adapter.state.getBundle(sessionId)?.questions).toHaveLength(1)

    await adapter.fetch(
      request(`/session/${session.id}/question/${secondQId}`, {
        method: "POST",
        body: JSON.stringify({ answers: ["Tailwind"] }),
      }),
    )

    await waitForIdle(adapter.state, sessionId)

    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle?.questions).toEqual([])
    const decision = engine.permissionDecisions[0] as {
      behavior: string
      updatedInput?: { answers?: Record<string, string> }
    }
    expect(decision.updatedInput?.answers).toEqual({
      "Which framework?": "React",
      "Which styling?": "Tailwind",
    })

    dispose()
  })

  test("abort resolves all pending questions", async () => {
    const { adapter, engine, dispose } = setup({
      kind: "askPermission",
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      input: MULTI_QUESTION_INPUT,
    })
    const session = await createSession(adapter)
    const sessionId = parseSessionId(session.id)

    await adapter.fetch(
      request(`/session/${session.id}/message`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ask me" }),
      }),
    )
    await waitForQuestion(adapter.state, sessionId)
    expect(adapter.state.getBundle(sessionId)?.questions).toHaveLength(2)

    await adapter.fetch(request(`/session/${session.id}/abort`, { method: "POST" }))
    await waitForAdapterIdle(adapter, sessionId)

    const bundle = adapter.state.getBundle(sessionId)
    expect(bundle?.questions).toEqual([])
    const decision = engine.permissionDecisions[0] as { behavior: string; message?: string }
    expect(decision.behavior).toBe("deny")
    expect(decision.message).toBe("user declined to answer")

    dispose()
  })

  test("unknown question ID returns 404", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "x" })
    const session = await createSession(adapter)

    const response = await adapter.fetch(
      request(`/session/${session.id}/question/q_unknown`, {
        method: "POST",
        body: JSON.stringify({ answers: ["x"] }),
      }),
    )
    const body = (await response.json()) as { error: string; message: string }

    expect(response.status).toBe(404)
    expect(body.error).toBe("question_not_found")
    expect(body.message).toContain("q_unknown")

    dispose()
  })

  test("unknown session for question reply returns 404", async () => {
    const { adapter, dispose } = setup({ kind: "text", text: "x" })

    const response = await adapter.fetch(
      request(`/session/ses_missing/question/q_abc`, {
        method: "POST",
        body: JSON.stringify({ answers: ["x"] }),
      }),
    )

    expect(response.status).toBe(404)
    dispose()
  })
})

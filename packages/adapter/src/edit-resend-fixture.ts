import type { PermissionResolver, SDKMessage, WrenEngine } from "@wren/engine"
import { EngineHistorySnapshot } from "@wren/engine"
import { parseSessionId } from "@wren/protocol"
import { createMemorySessionStore } from "@wren/storage"
import { createRoot } from "solid-js"
import { createWrenAdapter, type WrenAdapter } from "./local-adapter"

const FIXED_NOW = "2026-07-13T00:00:00.000Z"
const INTERNAL_ORIGIN = "http://wren.internal"

type EngineMessage = {
  readonly role: "user" | "assistant"
  readonly content: unknown
}

class ResendFailure extends Error {
  readonly name = "ResendFailure"
}

export class TransactionalFakeEngine implements WrenEngine {
  readonly submitMessageCalls: string[] = []
  readonly replacementStarted: Promise<void>
  private messages: EngineMessage[] = []
  private model = "fake/model"
  private turn = 0
  private readonly historyOwner = {}
  private readonly replacementStartedController = Promise.withResolvers<void>()
  private readonly replacementReleaseController = Promise.withResolvers<void>()

  constructor(initialMessages: readonly EngineMessage[] = []) {
    this.messages = [...initialMessages]
    this.replacementStarted = this.replacementStartedController.promise
  }

  async *submitMessage(prompt: string): AsyncGenerator<SDKMessage, void, unknown> {
    this.submitMessageCalls.push(prompt)
    this.messages.push({ role: "user", content: prompt })
    this.turn += 1
    yield systemInit(this.model)

    if (
      prompt === "replacement fails" ||
      prompt === "replacement succeeds" ||
      prompt === "replacement result error"
    ) {
      const assistant = assistantWithProjection(this.turn, "replacement", "/replacement.ts")
      this.messages.push({ role: "assistant", content: assistant.message.content })
      yield assistant
      const toolResult = userToolResult(this.turn, "replacement")
      this.messages.push({ role: "user", content: toolResult.message.content })
      yield toolResult
      if (prompt === "replacement fails") throw new ResendFailure("resend failed")
      if (prompt === "replacement result error") {
        yield resultFailure()
        return
      }
      this.replacementStartedController.resolve()
      await this.replacementReleaseController.promise
      yield resultSuccess()
      return
    }

    if (prompt === "original first") {
      const assistant = assistantWithProjection(this.turn, "original", "/original.ts")
      this.messages.push({ role: "assistant", content: assistant.message.content })
      yield assistant
      const toolResult = userToolResult(this.turn, "original")
      this.messages.push({ role: "user", content: toolResult.message.content })
      yield toolResult
    } else {
      const assistant = assistantWithText(this.turn, `answer to ${prompt}`)
      this.messages.push({ role: "assistant", content: assistant.message.content })
      yield assistant
    }
    yield resultSuccess()
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
    return this.messages
  }
  truncateMessages(count: number): void {
    this.messages = this.messages.slice(0, count)
  }
  snapshotHistory(): EngineHistorySnapshot {
    return EngineHistorySnapshot.capture(this.historyOwner, this.messages, (messages) => {
      this.messages = [...messages]
    })
  }
  restoreHistory(snapshot: EngineHistorySnapshot): void {
    snapshot.restoreFor(this.historyOwner)
  }
  dispose(): void {}
  releaseReplacement(): void {
    this.replacementReleaseController.resolve()
  }
  historyView(): readonly EngineMessage[] {
    return structuredClone(this.messages)
  }
}

export type OriginalBranchFixture = {
  readonly adapter: WrenAdapter
  readonly engine: TransactionalFakeEngine
  readonly sessionStore: ReturnType<typeof createMemorySessionStore>
  readonly sessionId: string
  readonly dispose: () => void
}

export function request(path: string, body: object): Request {
  return new Request(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

export async function createOriginalBranchFixture(
  sessionStore = createMemorySessionStore(),
): Promise<OriginalBranchFixture> {
  const fixture = createRoot((dispose) => {
    const engine = new TransactionalFakeEngine()
    const adapter = createWrenAdapter(engine, { clock: { now: () => FIXED_NOW }, sessionStore })
    return { adapter, engine, sessionStore, dispose }
  })
  const response = await fixture.adapter.fetch(request("/session", { cwd: "/tmp/project" }))
  const session = (await response.json()) as { id: string }
  const parsedSessionId = parseSessionId(session.id)
  await fixture.adapter.fetch(
    request(`/session/${session.id}/message`, { prompt: "original first" }),
  )
  await fixture.adapter.waitForIdle(parsedSessionId)
  await fixture.adapter.fetch(
    request(`/session/${session.id}/message`, { prompt: "original second" }),
  )
  await fixture.adapter.waitForIdle(parsedSessionId)
  return { ...fixture, sessionId: session.id }
}

export function firstUserMessageId(fixture: OriginalBranchFixture): string {
  const messageId = fixture.adapter.state
    .getBundle(parseSessionId(fixture.sessionId))
    ?.messages.find((message) => message.role === "user")?.id
  if (messageId === undefined) throw new Error("expected editable user message")
  return messageId
}

export function secondUserMessageId(fixture: OriginalBranchFixture): string {
  const messages = fixture.adapter.state
    .getBundle(parseSessionId(fixture.sessionId))
    ?.messages.filter((message) => message.role === "user")
  const messageId = messages?.[1]?.id
  if (messageId === undefined) throw new Error("expected second editable user message")
  return messageId
}

export function observableState(fixture: OriginalBranchFixture): string {
  const bundle = fixture.adapter.state.getBundle(parseSessionId(fixture.sessionId))
  return JSON.stringify({ bundle, history: fixture.engine.historyView() })
}

function systemInit(model: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp/project",
    session_id: "ses_edit",
    tools: ["TodoWrite", "Edit"],
    model,
    permissionMode: "default",
    uuid: "system-init",
  } as SDKMessage
}

function assistantWithText(
  turn: number,
  text: string,
): SDKMessage & {
  readonly message: { readonly content: readonly unknown[] }
} {
  return {
    type: "assistant",
    message: { role: "assistant", id: `assistant-${turn}`, content: [{ type: "text", text }] },
    uuid: `assistant-${turn}`,
  } as SDKMessage & { readonly message: { readonly content: readonly unknown[] } }
}

function assistantWithProjection(
  turn: number,
  label: string,
  filePath: string,
): SDKMessage & { readonly message: { readonly content: readonly unknown[] } } {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: `assistant-${turn}`,
      content: [
        {
          type: "tool_use",
          id: `todo-${turn}`,
          name: "TodoWrite",
          input: {
            todos: [{ id: `${label}-todo`, status: "completed", content: `${label} todo` }],
          },
        },
        { type: "tool_use", id: `edit-${turn}`, name: "Edit", input: { filePath } },
      ],
    },
    uuid: `assistant-${turn}`,
  } as SDKMessage & { readonly message: { readonly content: readonly unknown[] } }
}

function userToolResult(
  turn: number,
  label: string,
): SDKMessage & { readonly message: { readonly content: readonly unknown[] } } {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `todo-${turn}`, content: "ok" },
        {
          type: "tool_result",
          tool_use_id: `edit-${turn}`,
          content: JSON.stringify({ added: label.length, removed: 1 }),
        },
      ],
    },
    uuid: `tool-result-${turn}`,
  } as SDKMessage & { readonly message: { readonly content: readonly unknown[] } }
}

function resultSuccess(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "ses_edit",
    total_cost_usd: 0,
    usage: { input_tokens: 2, output_tokens: 3 },
    result: "",
  } as SDKMessage
}

function resultFailure(): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["terminal resend error"],
    duration_ms: 1,
    num_turns: 1,
    stop_reason: "error",
    session_id: "ses_edit",
    total_cost_usd: 0,
    usage: { input_tokens: 2, output_tokens: 0 },
    result: "",
  } as SDKMessage
}

import { describe, expect, test } from "bun:test"
import {
  CommandSchema,
  DiffSchema,
  EventEnvelopeSchema,
  ModelSchema,
  PartSchema,
  PermissionRequestSchema,
  parsePartId,
  parsePermissionId,
  parseRequestId,
  parseSessionId,
  QuestionRequestSchema,
  SessionSchema,
  StatusSchema,
  UsageSchema,
} from "./index"

describe("shared schemas", () => {
  test("parses a session event envelope when the payload shape is known", () => {
    const sessionId = parseSessionId("ses_fixture")

    const event = EventEnvelopeSchema.parse({
      id: parseRequestId("evt_fixture"),
      directory: "/tmp/project",
      payload: {
        type: "session.created",
        session: {
          id: sessionId,
          cwd: "/tmp/project",
          modelId: "claude-sonnet-4-5",
          permissionMode: "default",
        },
      },
    })

    expect(event.payload.type).toBe("session.created")
  })

  test("rejects unknown event payload types", () => {
    const result = EventEnvelopeSchema.safeParse({
      id: "evt_bad",
      directory: "/tmp/project",
      payload: { type: "cloud.upgrade.required" },
    })

    expect(result.success).toBe(false)
  })

  test("parses canonical projection buckets retained by the TUI matrix", () => {
    const sessionId = parseSessionId("ses_projection")

    const model = ModelSchema.parse({
      id: "fixture/sonnet",
      name: "Fixture Sonnet",
      contextLimit: 200000,
    })
    const command = CommandSchema.parse({ id: "cmd_plan", title: "/plan" })
    const question = QuestionRequestSchema.parse({
      id: parseRequestId("req_projection"),
      sessionId,
      title: "Need input",
      detail: "Pick one option.",
      options: [{ id: "yes", label: "Yes" }],
    })
    const diff = DiffSchema.parse({
      sessionId,
      files: [{ path: "README.md", added: 1, removed: 0 }],
      updatedAt: "2026-07-08T00:00:00.000Z",
    })

    expect(model.contextLimit).toBe(200000)
    expect(command.id).toBe("cmd_plan")
    expect(question.title).toBe("Need input")
    expect(diff.files).toHaveLength(1)
  })

  test("parses a Session with real fields", () => {
    const session = SessionSchema.parse({
      id: parseSessionId("ses_abc"),
      cwd: "/home/user/project",
      modelId: "claude-sonnet-4-5",
      modelRef: { source: "anthropic", model: "claude-sonnet-4-5", effort: "high" },
      permissionMode: "default",
    })

    expect(session.cwd).toBe("/home/user/project")
    expect(session.modelRef?.source).toBe("anthropic")
  })

  test("parses Usage mapped from BetaUsage", () => {
    const usage = UsageSchema.parse({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 200,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      costUsd: 0.015,
    })

    expect(usage.costUsd).toBe(0.015)
  })

  test("parses Status discriminated union variants", () => {
    const idle = StatusSchema.parse({ type: "idle" })
    const working = StatusSchema.parse({
      type: "working",
      model: "claude-sonnet-4-5",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
      },
      costUsd: 0.001,
    })
    const compacting = StatusSchema.parse({ type: "compacting" })
    const retry = StatusSchema.parse({ type: "retry", attempt: 1, maxRetries: 3 })

    expect(idle.type).toBe("idle")
    expect(working.type).toBe("working")
    expect(compacting.type).toBe("compacting")
    expect(retry.type).toBe("retry")
  })

  test("parses Part discriminated union — all four variants", () => {
    const text = PartSchema.parse({
      type: "text",
      id: parsePartId("part_text_1"),
      text: "hello",
    })
    const thinking = PartSchema.parse({
      type: "thinking",
      id: parsePartId("part_thinking_1"),
      text: "reasoning...",
    })
    const toolUse = PartSchema.parse({
      type: "tool_use",
      id: parsePartId("part_tool_1"),
      toolName: "Bash",
      input: { command: "ls" },
      status: "pending",
    })
    const toolResult = PartSchema.parse({
      type: "tool_result",
      id: parsePartId("part_result_1"),
      toolUseId: "toolu_123",
      content: "file.txt",
    })

    expect(text.type).toBe("text")
    expect(thinking.type).toBe("thinking")
    expect(toolUse.type).toBe("tool_use")
    expect(toolResult.type).toBe("tool_result")
    if (toolUse.type === "tool_use") {
      expect(toolUse.status).toBe("pending")
    }
    if (toolResult.type === "tool_result") {
      expect(toolResult.toolUseId).toBe("toolu_123")
    }
  })

  test("parses a PermissionRequest with displayType", () => {
    const req = PermissionRequestSchema.parse({
      id: parsePermissionId("perm_1"),
      sessionId: parseSessionId("ses_abc"),
      toolName: "Bash",
      input: { command: "rm -rf /" },
      displayType: "bash",
    })

    expect(req.displayType).toBe("bash")
  })
})

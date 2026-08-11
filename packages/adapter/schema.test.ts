import { describe, expect, test } from "bun:test"
import {
  CommandSchema,
  DiffSchema,
  EventEnvelopeSchema,
  ModelSchema,
  QuestionRequestSchema,
  parseRequestId,
  parseSessionId,
} from "@wren/protocol"

describe("adapter projection schemas", () => {
  test("parses retained TUI store buckets for model command question and diff", () => {
    const sessionId = parseSessionId("ses_schema")

    const model = ModelSchema.parse({
      id: "fixture/sonnet",
      name: "Fixture Sonnet",
      contextLimit: 200000,
    })
    const command = CommandSchema.parse({
      id: "cmd_help",
      title: "/help",
      description: "Show local commands",
    })
    const question = QuestionRequestSchema.parse({
      id: parseRequestId("req_question"),
      sessionId,
      title: "Choose a path",
      detail: "Fixture question for the TUI modal.",
      options: [{ id: "continue", label: "Continue" }],
    })
    const diff = DiffSchema.parse({
      sessionId,
      files: [{ path: "src/index.ts", added: 3, removed: 1 }],
      updatedAt: "2026-07-08T00:00:00.000Z",
    })

    expect(model.id).toBe("fixture/sonnet")
    expect(command.title).toBe("/help")
    expect(question.options[0]?.label).toBe("Continue")
    expect(diff.files[0]?.path).toBe("src/index.ts")
  })

  test("rejects unsupported cloud event types at the boundary", () => {
    const result = EventEnvelopeSchema.safeParse({
      id: parseRequestId("evt_bad_cloud"),
      directory: "/tmp/project",
      payload: { type: "cloud.upgrade.required" },
    })

    expect(result.success).toBe(false)
  })
})

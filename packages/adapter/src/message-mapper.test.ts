import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@wren/engine"
import { parseSessionId } from "@wren/protocol"
import { createRoot } from "solid-js"
import { consumeSDKMessageStream } from "./message-mapper"
import { createTuiStore } from "./store"

// ---------------------------------------------------------------------------
// Helpers — create async generators that yield SDKMessage fixtures
// ---------------------------------------------------------------------------

async function* streamFrom(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void, unknown> {
  for (const message of messages) {
    yield message
  }
}

function setup() {
  const sessionId = parseSessionId("ses_test")
  return createRoot((dispose) => {
    const store = createTuiStore()
    store.addSession({
      id: sessionId,
      cwd: "/tmp/project",
      modelId: "claude-sonnet-4-5",
      permissionMode: "default",
    })
    return {
      sessionId,
      store,
      dispose,
      consume: (messages: SDKMessage[]) =>
        consumeSDKMessageStream(streamFrom(messages), {
          clock: { now: () => "2026-07-08T00:00:00.000Z" },
          sessionId,
          store,
        }),
    }
  })
}

// ---------------------------------------------------------------------------
// Fixture builders — real SDKMessage shapes from the QueryEngine
// ---------------------------------------------------------------------------

function systemInit(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp/project",
    session_id: "ses_test",
    tools: ["Bash", "Read", "Write"],
    model: "claude-sonnet-4-5",
    permissionMode: "default",
    uuid: "00000000-0000-0000-0000-000000000001",
  } as SDKMessage
}

function assistantBlock(id: string, uuid: string, content: Record<string, unknown>[]): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id,
      content,
    },
    uuid,
  } as SDKMessage
}

function assistantWithText(text: string, uuid: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_api_1",
      content: [{ type: "text", text }],
    },
    uuid,
  } as SDKMessage
}

function assistantWithThinking(thinking: string, uuid: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_api_2",
      content: [
        { type: "thinking", thinking, signature: "sig_123" },
        { type: "text", text: "Done thinking." },
      ],
    },
    uuid,
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
      id: "msg_api_3",
      content: [
        { type: "text", text: "Let me run a command." },
        { type: "tool_use", id: toolUseId, name: toolName, input },
      ],
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
    session_id: "ses_test",
  } as SDKMessage
}

function streamEventMessage(event: Record<string, unknown>): SDKMessage {
  return {
    type: "stream_event",
    event,
    session_id: "ses_test",
    uuid: "00000000-0000-0000-0000-000000000099",
  } as SDKMessage
}

function resultSuccess(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 500,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "ses_test",
    total_cost_usd: 0.015,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    },
    result: "hello back",
  } as SDKMessage
}

function resultError(subtype: string): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    duration_ms: 1000,
    duration_api_ms: 500,
    num_turns: 1,
    stop_reason: null,
    session_id: "ses_test",
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    errors: ["Something went wrong"],
  } as SDKMessage
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("message mapper", () => {
  test("maps system(init) + assistant(text) + result(success) → idle status with text part", async () => {
    const { store, sessionId, consume, dispose } = setup()

    await consume([systemInit(), assistantWithText("hello", "uuid-msg-1"), resultSuccess()])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()
    expect(bundle?.status.type).toBe("idle")

    const assistantMessages = bundle?.messages.filter((m) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(1)
    const textParts = assistantMessages[0]?.parts.filter((p) => p.type === "text")
    expect(textParts).toHaveLength(1)
    expect(textParts[0]?.type).toBe("text")
    if (textParts[0]?.type === "text") {
      expect(textParts[0]?.text).toBe("hello")
    }

    dispose()
  })

  test("maps tool_use → pending status, then tool_result → completed status", async () => {
    const { store, sessionId, consume, dispose } = setup()

    await consume([
      systemInit(),
      assistantWithToolUse("toolu_123", "Bash", { command: "ls" }, "uuid-msg-2"),
      userToolResult("toolu_123", "file.txt\ndir/", "uuid-msg-3"),
      resultSuccess(),
    ])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()

    // Find the tool_use part across all messages
    let toolPart: { type: string; status?: string; output?: unknown } | null = null
    for (const msg of bundle?.messages ?? []) {
      for (const part of msg.parts) {
        if (part.type === "tool_use") {
          toolPart = part
        }
      }
    }

    expect(toolPart).not.toBeNull()
    expect(toolPart?.type).toBe("tool_use")
    expect(toolPart?.status).toBe("completed")
    expect(toolPart?.output).toBe("file.txt\ndir/")

    dispose()
  })

  test("preserves structured agentId when a large Agent result is replaced by a persisted preview", async () => {
    const { store, sessionId, consume, dispose } = setup()

    await consume([
      systemInit(),
      assistantWithToolUse(
        "toolu_agent_large",
        "Agent",
        { description: "Audit storage", subagent_type: "Explore" },
        "uuid-agent-large",
      ),
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_agent_large",
              content: "<persisted-output>\nPreview (first 2.0 KB):\nlarge output\n</persisted-output>",
            },
          ],
        },
        tool_use_result: {
          agentId: "a0123456789abcdef",
          content: [{ type: "text", text: "large output omitted from preview" }],
        },
        uuid: "uuid-agent-large-result",
        session_id: "ses_test",
      } as SDKMessage,
    ])

    const toolPart = store
      .getBundle(sessionId)
      ?.messages.flatMap((message) => message.parts)
      .find((part) => part.type === "tool_use" && part.id === "part_tool_toolu_agent_large")

    expect(toolPart).toMatchObject({
      type: "tool_use",
      status: "completed",
      agentId: "a0123456789abcdef",
      output: "<persisted-output>\nPreview (first 2.0 KB):\nlarge output\n</persisted-output>",
    })

    dispose()
  })

  test("historical plan tools do not overwrite the current permission mode", async () => {
    const { store, sessionId, consume, dispose } = setup()

    await consume([
      assistantBlock("msg_plan_enter", "uuid-plan-enter", [
        { type: "tool_use", id: "toolu_plan_enter", name: "EnterPlanMode", input: {} },
      ]),
      userToolResult("toolu_plan_enter", "entered", "uuid-plan-enter-result"),
      assistantBlock("msg_plan_exit", "uuid-plan-exit", [
        { type: "tool_use", id: "toolu_plan_exit", name: "ExitPlanMode", input: {} },
      ]),
      userToolResult("toolu_plan_exit", "exited", "uuid-plan-exit-result"),
      assistantBlock("msg_orphan_exit", "uuid-orphan-exit", [
        { type: "tool_use", id: "toolu_orphan_exit", name: "ExitPlanMode", input: {} },
      ]),
      userToolResult("toolu_orphan_exit", "exited", "uuid-orphan-exit-result"),
    ])
    store.setSessionPermissionMode(sessionId, "auto")

    await consume([
      assistantBlock("msg_unrelated_tool", "uuid-unrelated-tool", [
        { type: "tool_use", id: "toolu_unrelated", name: "Bash", input: { command: "true" } },
      ]),
      userToolResult("toolu_unrelated", "ok", "uuid-unrelated-result"),
    ])

    expect(store.getSession(sessionId)?.permissionMode).toBe("auto")
    dispose()
  })

  test("keeps consuming through result after a tool-result boundary callback", async () => {
    const { store, sessionId, dispose } = setup()
    let boundaries = 0

    await consumeSDKMessageStream(
      streamFrom([
        systemInit(),
        assistantWithToolUse("toolu_boundary", "Bash", { command: "true" }, "uuid-boundary-1"),
        userToolResult("toolu_boundary", "ok", "uuid-boundary-2"),
        resultSuccess(),
      ]),
      {
        clock: { now: () => "2026-07-08T00:00:00.000Z" },
        sessionId,
        store,
        onTurnBoundary: () => {
          boundaries++
        },
      },
    )

    expect(boundaries).toBe(1)
    expect(store.getBundle(sessionId)?.status.type).toBe("idle")
    dispose()
  })

  test("maps thinking block → Part type thinking", async () => {
    const { store, sessionId, consume, dispose } = setup()

    await consume([
      systemInit(),
      assistantWithThinking("I should consider the options.", "uuid-msg-4"),
      resultSuccess(),
    ])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()

    const assistantMessages = bundle?.messages.filter((m) => m.role === "assistant")
    const thinkingParts = assistantMessages[0]?.parts.filter((p) => p.type === "thinking")
    expect(thinkingParts).toHaveLength(1)
    if (thinkingParts[0]?.type === "thinking") {
      expect(thinkingParts[0]?.text).toBe("I should consider the options.")
    }

    dispose()
  })

  test("appends text incrementally from content_block_delta (not replace)", async () => {
    const { store, sessionId, consume, dispose } = setup()

    const messageId = "uuid-msg-5"
    await consume([
      systemInit(),
      // message_start
      streamEventMessage({
        type: "message_start",
        message: { id: "msg_api_5", model: "claude-sonnet-4-5" },
      }),
      // content_block_start — empty text block
      streamEventMessage({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      // First delta
      streamEventMessage({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
      // Second delta — should append, not replace
      streamEventMessage({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " World" },
      }),
      // content_block_stop
      streamEventMessage({ type: "content_block_stop", index: 0 }),
      // assistant message with final content
      assistantWithText("Hello World", messageId),
      resultSuccess(),
    ])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()

    // The assistant message should have the full text
    const assistantMessages = bundle?.messages.filter((m) => m.role === "assistant")
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)

    // Find the text part — either from streaming or the final assistant message
    let fullText = ""
    for (const msg of assistantMessages) {
      for (const part of msg.parts) {
        if (part.type === "text") {
          fullText = part.text
        }
      }
    }
    expect(fullText).toContain("Hello World")

    dispose()
  })

  test("maps result(error) → idle status with error recorded", async () => {
    const { store, sessionId, consume, dispose } = setup()

    await consume([
      systemInit(),
      assistantWithText("working on it...", "uuid-msg-6"),
      resultError("error_during_execution"),
    ])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()
    expect(bundle?.status.type).toBe("idle")

    dispose()
  })

  test("unknown SDKMessage type is silently skipped (no crash)", async () => {
    const { consume, dispose } = setup()

    const unknown = { type: "totally_unknown_type" } as SDKMessage

    await consume([unknown])

    dispose()
  })

  test("per-block assistant messages with same message.id accumulate into one message", async () => {
    const { store, sessionId, consume, dispose } = setup()

    const msgId = "msg_api_parallel"
    await consume([
      systemInit(),
      streamEventMessage({
        type: "message_start",
        message: { id: msgId, model: "claude-sonnet-4-5" },
      }),
      streamEventMessage({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      streamEventMessage({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Running tools." },
      }),
      streamEventMessage({ type: "content_block_stop", index: 0 }),
      streamEventMessage({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
      }),
      streamEventMessage({ type: "content_block_stop", index: 1 }),
      streamEventMessage({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_b", name: "Read", input: {} },
      }),
      streamEventMessage({ type: "content_block_stop", index: 2 }),
      assistantBlock(msgId, "uuid-block-1", [{ type: "text", text: "Running tools." }]),
      assistantBlock(msgId, "uuid-block-2", [
        { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "ls" } },
      ]),
      assistantBlock(msgId, "uuid-block-3", [
        { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "/tmp/x" } },
      ]),
      resultSuccess(),
    ])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()

    const assistantMessages = bundle?.messages.filter((m) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(1)

    const parts = assistantMessages[0]?.parts
    const textParts = parts.filter((p) => p.type === "text")
    expect(textParts).toHaveLength(1)
    if (textParts[0]?.type === "text") {
      expect(textParts[0]?.text).toBe("Running tools.")
    }

    const toolUseParts = parts.filter((p) => p.type === "tool_use")
    expect(toolUseParts).toHaveLength(2)
    if (toolUseParts[0]?.type === "tool_use") {
      expect(toolUseParts[0]?.toolName).toBe("Bash")
    }
    if (toolUseParts[1]?.type === "tool_use") {
      expect(toolUseParts[1]?.toolName).toBe("Read")
    }

    dispose()
  })

  test("streaming text then per-block tool_use preserves both text and tools", async () => {
    const { store, sessionId, consume, dispose } = setup()

    const msgId = "msg_mixed"
    await consume([
      systemInit(),
      streamEventMessage({
        type: "message_start",
        message: { id: msgId, model: "claude-sonnet-4-5" },
      }),
      streamEventMessage({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      streamEventMessage({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me check." },
      }),
      streamEventMessage({ type: "content_block_stop", index: 0 }),
      streamEventMessage({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_c", name: "Bash", input: {} },
      }),
      streamEventMessage({ type: "content_block_stop", index: 1 }),
      assistantBlock(msgId, "uuid-text-block", [{ type: "text", text: "Let me check." }]),
      assistantBlock(msgId, "uuid-tool-block", [
        { type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "pwd" } },
      ]),
      resultSuccess(),
    ])

    const bundle = store.getBundle(sessionId)
    expect(bundle).toBeDefined()

    const assistantMessages = bundle?.messages.filter((m) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(1)

    const parts = assistantMessages[0]?.parts
    expect(parts.filter((p) => p.type === "text")).toHaveLength(1)
    expect(parts.filter((p) => p.type === "tool_use")).toHaveLength(1)

    dispose()
  })
})
describe("compact message projection", () => {
  test("does not turn a manual compact status into working on init", async () => {
    const { store, sessionId, dispose } = setup()
    store.setStatus(sessionId, { type: "compacting" })

    await consumeSDKMessageStream(streamFrom([systemInit()]), {
      clock: { now: () => "2026-07-08T00:00:00.000Z" },
      sessionId,
      store,
    })

    expect(store.getBundle(sessionId)?.status.type).toBe("compacting")
    dispose()
  })

  test("maps the auto-compact summary as a fold message and leaves compacting status at the boundary", async () => {
    const { store, sessionId, dispose } = setup()
    store.setStatus(sessionId, { type: "compacting" })
    let boundaries = 0

    await consumeSDKMessageStream(
      streamFrom([
        {
          type: "user",
          message: { role: "user", content: "internal compact summary" },
          uuid: "uuid-compact-summary",
          session_id: "ses_test",
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          isSynthetic: true,
        } as SDKMessage,
        {
          type: "system",
          subtype: "compact_boundary",
          session_id: "ses_test",
          uuid: "uuid-compact-boundary",
        } as SDKMessage,
      ]),
      {
        clock: { now: () => "2026-07-08T00:00:00.000Z" },
        sessionId,
        store,
        onTurnBoundary: () => {
          boundaries++
        },
      },
    )

    expect(store.getBundle(sessionId)?.messages).toHaveLength(1)
    expect(store.getBundle(sessionId)?.messages[0]?.parts[0]).toEqual({
      type: "text",
      id: "part_text_uuid-compact-summary",
      text: "<compact-summary>internal compact summary</compact-summary>",
    })
    expect(store.getBundle(sessionId)?.status.type).toBe("compacting")
    expect(boundaries).toBe(0)
    dispose()
  })

  test("maps synthetic compact output to a structured summary", async () => {
    const { store, sessionId, dispose } = setup()

    await consumeSDKMessageStream(
      streamFrom([
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "<synthetic>",
            id: "assistant-compact",
            content: [
              {
                type: "text",
                text: "Compacted\n<compact-summary>## Summary\n- kept</compact-summary>",
              },
            ],
          },
          uuid: "uuid-compact-output",
        } as SDKMessage,
      ]),
      {
        clock: { now: () => "2026-07-08T00:00:00.000Z" },
        sessionId,
        store,
      },
    )

    const message = store.getBundle(sessionId)?.messages[0]
    expect(message?.compactSummary).toEqual({
      notification: "Compacted",
      summary: "## Summary\n- kept",
    })
    expect(message?.parts).toEqual([
      {
        type: "text",
        id: "part_text_assistant-compact_0",
        text: "Compacted",
      },
    ])
    dispose()
  })
  test("maps an auto-compact summary user message to a marker-wrapped fold message", async () => {
    const { store, sessionId, dispose } = setup()

    await consumeSDKMessageStream(
      streamFrom([
        {
          type: "user",
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          message: {
            role: "user",
            content:
              "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- kept",
          },
          uuid: "uuid-compact-summary",
        } as SDKMessage,
      ]),
      {
        clock: { now: () => "2026-07-08T00:00:00.000Z" },
        sessionId,
        store,
      },
    )

    const message = store.getBundle(sessionId)?.messages[0]
    expect(message?.role).toBe("user")
    expect(message?.parts).toEqual([
      {
        type: "text",
        id: "part_text_uuid-compact-summary",
        text: "<compact-summary>This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- kept</compact-summary>",
      },
    ])
    dispose()
  })
  test("still drops non-summary invisible/synthetic user messages", async () => {
    const { store, sessionId, dispose } = setup()

    await consumeSDKMessageStream(
      streamFrom([
        {
          type: "user",
          isVisibleInTranscriptOnly: true,
          message: { role: "user", content: "internal-only" },
          uuid: "uuid-invisible",
        } as SDKMessage,
        {
          type: "user",
          isSynthetic: true,
          message: { role: "user", content: "synthetic" },
          uuid: "uuid-synthetic",
        } as SDKMessage,
      ]),
      {
        clock: { now: () => "2026-07-08T00:00:00.000Z" },
        sessionId,
        store,
      },
    )

    expect(store.getBundle(sessionId)?.messages).toHaveLength(0)
    dispose()
  })
  test("preserves compact progress segments without putting them in messages", () => {
    const { store, sessionId, dispose } = setup()
    store.setCompactProgress(sessionId, { phase: "summarizing", segments: [] })
    store.appendCompactProgress(sessionId, "text", "summary")
    store.appendCompactProgress(sessionId, "thinking", "reasoning")
    store.appendCompactProgress(sessionId, "text", " continues")

    expect(store.getBundle(sessionId)?.messages).toHaveLength(0)
    expect(store.store.compactProgress[sessionId]?.segments).toEqual([
      { type: "text", text: "summary" },
      { type: "thinking", text: "reasoning" },
      { type: "text", text: " continues" },
    ])
    dispose()
  })
})

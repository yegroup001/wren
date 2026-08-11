import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs"

let events: BetaRawMessageStreamEvent[] = []
let costCalls: Array<{ model: string; usage: Record<string, number> }> = []
let totalCalls: Array<{ costUsd: number; model: string; usage: Record<string, number> }> = []

async function* eventStream(): AsyncGenerator<BetaRawMessageStreamEvent> {
  for (const event of events) yield event
}

mock.module("@wren/model-provider", () => ({
  resolveGeminiModel: (model: string) => model,
  adaptGeminiStreamToAnthropic: () => eventStream(),
  anthropicMessagesToGemini: () => ({ contents: [], systemInstruction: undefined }),
  anthropicToolsToGemini: () => [],
  anthropicToolChoiceToGemini: () => undefined,
  GEMINI_THOUGHT_SIGNATURE_FIELD: "thoughtSignature",
}))

mock.module("../client.js", () => ({
  streamGeminiGenerateContent: () => ({ [Symbol.asyncIterator]: async function* () {} }),
}))

mock.module("../../../../utils/messages.js", () => ({
  normalizeMessagesForAPI: (messages: unknown[]) => messages,
  normalizeContentFromAPI: (blocks: unknown[]) => blocks,
  createAssistantAPIErrorMessage: (options: { content: string; apiError: string }) => ({
    type: "assistant",
    message: { content: [{ type: "text", text: options.content }], apiError: options.apiError },
    uuid: "error-uuid",
    timestamp: new Date().toISOString(),
  }),
}))

mock.module("../../../../utils/api.js", () => ({
  toolToAPISchema: async (tool: unknown) => tool,
}))

mock.module("../../../../utils/modelCost.js", () => ({
  calculateUSDCost: (model: string, usage: Record<string, number>) => {
    costCalls.push({ model, usage: { ...usage } })
    return 0
  },
}))

mock.module("../../../../cost-tracker.js", () => ({
  addToTotalSessionCost: (costUsd: number, usage: Record<string, number>, model: string) => {
    totalCalls.push({ costUsd, model, usage: { ...usage } })
  },
}))

mock.module("../../../../utils/debug.js", () => ({
  logForDebugging: () => {},
}))

async function collectGeminiQuery(): Promise<unknown[]> {
  const { queryModelGemini } = await import("../index.js")
  const options: any = {
    model: "gemini-test-model",
    tools: [],
    agents: [],
    querySource: "main_loop",
    getToolPermissionContext: async () => ({
      alwaysAllow: [],
      alwaysDeny: [],
      needsPermission: [],
      mode: "default",
      isBypassingPermissions: false,
    }),
  }

  const outputs: unknown[] = []
  for await (const item of queryModelGemini(
    [],
    { type: "text", text: "" } as any,
    [],
    new AbortController().signal,
    options,
    { type: "disabled" },
  )) {
    outputs.push(item)
  }
  return outputs
}

async function exhaustGeminiQuery(): Promise<void> {
  await collectGeminiQuery()
}

beforeEach(() => {
  events = []
  costCalls = []
  totalCalls = []
})

describe("queryModelGemini usage accounting", () => {
  test("forwards merged trailing usage once to session accounting", async () => {
    events = [
      {
        type: "message_delta",
        delta: { stop_reason: null, stop_sequence: null },
        usage: {
          input_tokens: 120,
          output_tokens: 0,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 5,
        },
      } as any,
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 30 },
      } as any,
      { type: "message_stop" } as any,
    ]

    await exhaustGeminiQuery()

    expect(costCalls).toEqual([
      {
        model: "gemini-test-model",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          reasoning_tokens: 0,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 40,
        },
      },
    ])
    expect(totalCalls).toEqual([
      {
        costUsd: 0,
        model: "gemini-test-model",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          reasoning_tokens: 0,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 40,
        },
      },
    ])
  })

  test("does not record a zero-token response", async () => {
    events = [
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      } as any,
      { type: "message_stop" } as any,
    ]

    await exhaustGeminiQuery()

    expect(costCalls).toEqual([])
    expect(totalCalls).toEqual([])
  })
})

describe("queryModelGemini finalization", () => {
  test("emits one complete message and accounts once when message_stop is duplicated", async () => {
    events = [
      {
        type: "message_start",
        message: {
          id: "gemini-response",
          type: "message",
          role: "assistant",
          model: "gemini-test-model",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [],
        },
      } as any,
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } as any,
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "second" },
      } as any,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "first " },
      } as any,
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          reasoning_tokens: 3,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 5,
        },
      } as any,
      { type: "message_stop" } as any,
      { type: "message_stop" } as any,
    ]

    const outputs = await collectGeminiQuery()
    const assistantMessages = outputs.filter((item: any) => item.type === "assistant")

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].message.content).toEqual([
      { type: "text", text: "first " },
      { type: "text", text: "second" },
    ])
    expect(assistantMessages[0].message.stop_reason).toBe("end_turn")
    expect(assistantMessages[0].message.usage).toMatchObject({
      input_tokens: 11,
      output_tokens: 7,
      reasoning_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 5,
    })
    expect(costCalls).toHaveLength(1)
    expect(totalCalls).toHaveLength(1)
  })

  test("finalizes exactly once when the stream ends without message_stop", async () => {
    events = [
      {
        type: "message_start",
        message: {
          id: "gemini-abrupt-response",
          type: "message",
          role: "assistant",
          model: "gemini-test-model",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [],
        },
      } as any,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      } as any,
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 4, output_tokens: 2 },
      } as any,
    ]

    const outputs = await collectGeminiQuery()
    const assistantMessages = outputs.filter((item: any) => item.type === "assistant")

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].message.content).toEqual([{ type: "text", text: "partial" }])
    expect(assistantMessages[0].message.stop_reason).toBe("end_turn")
    expect(costCalls).toHaveLength(1)
    expect(totalCalls).toHaveLength(1)
  })
})

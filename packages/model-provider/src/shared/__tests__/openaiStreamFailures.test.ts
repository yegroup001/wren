import { describe, expect, test } from "bun:test"
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions.mjs"
import {
  adaptOpenAIStreamToAnthropic,
  adaptOpenAIStreamToAnthropicWithRetry,
  IncompleteOpenAIStreamError,
} from "../openaiStreamAdapter.js"

type Choice = ChatCompletionChunk["choices"][number]

function makeChunk(choices: readonly Choice[]): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [...choices],
  }
}

function partialTextChunk(): ChatCompletionChunk {
  return makeChunk([
    {
      index: 0,
      delta: { content: "partial output" },
      finish_reason: null,
    },
  ])
}

async function* stream(
  chunks: readonly ChatCompletionChunk[],
): AsyncGenerator<ChatCompletionChunk, void> {
  yield* chunks
}

async function consume(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const item of iterable) {
    void item
  }
}

async function collectEventTypes(
  iterable: AsyncIterable<{ readonly type: string }>,
  eventTypes: string[],
): Promise<void> {
  for await (const event of iterable) {
    eventTypes.push(event.type)
  }
}

describe("OpenAI stream failure boundaries", () => {
  test("rejects partial content when EOF arrives before a finish reason", async () => {
    // Given: the provider emits semantic content but closes before a terminal chunk.
    const eventTypes: string[] = []
    const consuming = collectEventTypes(
      adaptOpenAIStreamToAnthropic(stream([partialTextChunk()]), "test"),
      eventTypes,
    )

    // When/Then: the partial response is classified as a non-retryable truncation.
    await expect(consuming).rejects.toMatchObject({
      name: "IncompleteOpenAIStreamError",
      kind: "truncated",
      canRetry: false,
    })
    expect(eventTypes.at(-1)).toBe("content_block_stop")
  })

  test("does not retry after partial content has been exposed", async () => {
    // Given: every attempted stream would emit content and then truncate.
    let attempts = 0
    const consuming = consume(
      adaptOpenAIStreamToAnthropicWithRetry(async () => {
        attempts++
        return stream([partialTextChunk()])
      }, "test"),
    )

    // When/Then: the first truncation stops recovery before duplicate output can be emitted.
    await expect(consuming).rejects.toBeInstanceOf(IncompleteOpenAIStreamError)
    expect(attempts).toBe(1)
  })

  test("retries five empty streams before surfacing the failure", async () => {
    // Given: the provider repeatedly returns a successful SSE response with no chunks.
    let attempts = 0
    const consuming = consume(
      adaptOpenAIStreamToAnthropicWithRetry(async () => {
        attempts++
        return stream([])
      }, "test"),
    )

    // When/Then: transient main-session gaps receive five total attempts.
    await expect(consuming).rejects.toBeInstanceOf(IncompleteOpenAIStreamError)
    expect(attempts).toBe(5)
  })

  test("preserves nested response failure metadata", async () => {
    // Given: a Responses failure event is delivered through the Chat Completions SSE parser.
    const failedChunk = Object.assign(makeChunk([]), {
      type: "response.failed" as const,
      response: {
        status: "failed" as const,
        error: {
          code: "server_error",
          message: "upstream boom",
        },
      },
    })
    const eventTypes: string[] = []
    const consuming = collectEventTypes(
      adaptOpenAIStreamToAnthropic(stream([failedChunk]), "test"),
      eventTypes,
    )

    // When/Then: Wren retains the machine-readable failure classification and provider detail.
    await expect(consuming).rejects.toMatchObject({
      name: "IncompleteOpenAIStreamError",
      kind: "provider_failed",
      canRetry: true,
      providerMessage: "upstream boom",
    })
    expect(eventTypes).toEqual([])
  })
})

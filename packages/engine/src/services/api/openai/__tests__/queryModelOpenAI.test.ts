import { afterEach, describe, expect, test } from "bun:test"
import type { WrenConfig } from "@wren/config-node"
import { createUserMessage } from "../../../../utils/messages.js"
import { setConfigForTests } from "../../../../utils/model/configBridge.js"
import { asSystemPrompt } from "../../../../utils/systemPromptType.js"
import type { Options } from "../../claude.js"
import { clearOpenAIClientCache } from "../client.js"
import { queryModelOpenAI } from "../index.js"

const MODEL = "test-source/test-model"
const config: WrenConfig = {
  defaultModel: { source: "test-source", model: "test-model" },
  smallFastModel: { source: "test-source", model: "test-model" },
  sources: {
    "test-source": {
      type: "openai-compatible-chat",
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
      models: {
        "test-model": {
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsThinking: false,
        },
      },
    },
  },
}

function sse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function successfulStream(): Response {
  const chunks = [
    {
      id: "chatcmpl-recovered",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-recovered",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-recovered",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
    },
  ]
  return sse(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
  )
}

function createOptions(fetchOverride: NonNullable<Options["fetchOverride"]>): Options {
  return {
    model: MODEL,
    isNonInteractiveSession: true,
    querySource: "main_loop",
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    getToolPermissionContext: async () => ({
      alwaysAllow: [],
      alwaysDeny: [],
      needsPermission: [],
      mode: "default",
      isBypassingPermissions: false,
    }),
    fetchOverride,
  }
}

async function runQuery(options: Options) {
  const outputs = []
  for await (const output of queryModelOpenAI(
    [createUserMessage({ content: "test" })],
    asSystemPrompt(["system"]),
    [],
    new AbortController().signal,
    options,
  )) {
    outputs.push(output)
  }
  return outputs
}

afterEach(() => {
  setConfigForTests(null)
  clearOpenAIClientCache()
})

describe("queryModelOpenAI incomplete stream recovery", () => {
  test("retries empty SSE responses before completing the turn", async () => {
    // Given: the configured provider closes two requests without emitting any SSE chunks.
    setConfigForTests(config)
    let attempts = 0
    const options = createOptions(async () => {
      attempts++
      return attempts < 3 ? sse("") : successfulStream()
    })

    // When: the OpenAI-compatible query consumes the provider stream.
    const outputs = await runQuery(options)

    // Then: the third request completes with assistant content instead of a silent result.
    expect(attempts).toBe(3)
    expect(JSON.stringify(outputs)).toContain("recovered")
  })

  test("surfaces an API error after incomplete stream retries are exhausted", async () => {
    // Given: every provider attempt closes without emitting an SSE chunk.
    setConfigForTests(config)
    let attempts = 0
    const options = createOptions(async () => {
      attempts++
      return sse("")
    })

    // When: the OpenAI-compatible query exhausts its incomplete-stream retry budget.
    const outputs = await runQuery(options)

    // Then: the turn contains a visible API error rather than ending with no assistant message.
    expect(attempts).toBe(5)
    expect(
      outputs.some((output) => output.type === "assistant" && output.isApiErrorMessage === true),
    ).toBe(true)
  })
})

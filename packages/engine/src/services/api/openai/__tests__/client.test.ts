import { afterEach, describe, expect, test } from "bun:test"
import { clearOpenAIClientCache, getOpenAIClient } from "../client.js"

const originalEnv = {
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
}

afterEach(() => {
  clearOpenAIClientCache()
  if (originalEnv.apiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalEnv.apiKey
  if (originalEnv.baseUrl === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalEnv.baseUrl
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function response(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

describe("OpenAI client provider isolation", () => {
  test("keeps concurrent explicit providers on their own endpoint and credential", async () => {
    const entered = deferred()
    let enteredCount = 0
    const requests: Array<{
      url: string
      authorization: string
      model: string
      maxTokens: number
    }> = []

    const createFetch =
      (release: { promise: Promise<void> }) =>
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        const body = JSON.parse(String(init?.body)) as {
          model: string
          max_tokens: number
        }
        requests.push({
          url,
          authorization: headers.get("authorization") ?? "",
          model: body.model,
          maxTokens: body.max_tokens,
        })
        enteredCount += 1
        if (enteredCount === 2) entered.resolve()
        await release.promise
        return response()
      }

    const releaseA = deferred()
    const releaseB = deferred()
    const clientA = getOpenAIClient({
      provider: { apiKey: "key-a", baseURL: "https://provider-a.example/v1" },
      fetchOverride: createFetch(releaseA),
    })
    const clientB = getOpenAIClient({
      provider: { apiKey: "key-b", baseURL: "https://provider-b.example/v1" },
      fetchOverride: createFetch(releaseB),
    })

    const requestA = clientA.chat.completions.create({
      model: "model-a",
      messages: [],
      max_tokens: 111,
      stream: true,
    })
    const requestB = clientB.chat.completions.create({
      model: "model-b",
      messages: [],
      max_tokens: 222,
      stream: true,
    })

    await entered.promise
    releaseA.resolve()
    releaseB.resolve()
    await Promise.all([requestA, requestB])

    expect(requests).toHaveLength(2)
    expect(requests).toContainEqual({
      url: "https://provider-a.example/v1/chat/completions",
      authorization: "Bearer key-a",
      model: "model-a",
      maxTokens: 111,
    })
    expect(requests).toContainEqual({
      url: "https://provider-b.example/v1/chat/completions",
      authorization: "Bearer key-b",
      model: "model-b",
      maxTokens: 222,
    })
  })

  test("does not reuse an explicit provider client after switching sources", () => {
    const clientA = getOpenAIClient({
      provider: { apiKey: "key-a", baseURL: "https://provider-a.example/v1" },
      fetchOverride: async () => response(),
    })
    const clientB = getOpenAIClient({
      provider: { apiKey: "key-b", baseURL: "https://provider-b.example/v1" },
      fetchOverride: async () => response(),
    })

    expect(clientB).not.toBe(clientA)
  })
})

import { describe, expect, test } from "bun:test"
import { streamGeminiGenerateContent } from "../client"

function sseResponse(status: number, body = ""): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function collect(params: {
  model: string
  body: unknown
  signal: AbortSignal
  fetchOverride: typeof fetch
}): Promise<{ chunks: unknown[]; fetchCount: number }> {
  let fetchCount = 0
  const wrapped: typeof fetch = async (...args) => {
    fetchCount++
    return params.fetchOverride(...args)
  }
  const chunks: unknown[] = []
  try {
    for await (const chunk of streamGeminiGenerateContent({ ...params, fetchOverride: wrapped })) {
      chunks.push(chunk)
    }
  } catch (error) {
    return { chunks, fetchCount, error: error as Error } as never
  }
  return { chunks, fetchCount }
}

describe("streamGeminiGenerateContent retry", () => {
  test("retries 429 with backoff and succeeds", async () => {
    let calls = 0
    const result = await collect({
      model: "gemini-2.5-pro",
      body: { contents: [] },
      signal: new AbortController().signal,
      fetchOverride: (async () => {
        calls++
        if (calls === 1) {
          return sseResponse(429, "rate limited")
        }
        if (calls === 2) {
          return sseResponse(503, "overloaded")
        }
        return sseResponse(
          200,
          'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\ndata: [DONE]\n\n',
        )
      }) as typeof fetch,
    })
    expect(calls).toBe(3)
    expect(result.fetchCount).toBe(3)
    expect(result.chunks.length).toBeGreaterThan(0)
    expect((result.chunks[0] as { candidates: unknown[] }).candidates).toBeDefined()
  })

  test("fails after exhausting retries on persistent 500", async () => {
    const result = await collect({
      model: "gemini-2.5-pro",
      body: { contents: [] },
      signal: new AbortController().signal,
      fetchOverride: (async () => sseResponse(500, "boom")) as typeof fetch,
    })
    expect(result.fetchCount).toBe(3)
    expect(result.error).toBeInstanceOf(Error)
  })

  test("does not retry 4xx non-transient errors", async () => {
    const result = await collect({
      model: "gemini-2.5-pro",
      body: { contents: [] },
      signal: new AbortController().signal,
      fetchOverride: (async () => sseResponse(400, "bad request")) as typeof fetch,
    })
    expect(result.fetchCount).toBe(1)
    expect(result.error).toBeInstanceOf(Error)
  })
})

import type { GeminiGenerateContentRequest, GeminiStreamChunk } from "@wren/model-provider"
import { parseSSEFrames } from "src/cli/transports/SSETransport.js"
import { errorMessage } from "src/utils/errors.js"
import { getProxyFetchOptions } from "src/utils/proxy.js"

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

function getGeminiBaseUrl(): string {
  return (process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "")
}

function getGeminiModelPath(model: string): string {
  const normalized = model.replace(/^\/+/, "")
  return normalized.startsWith("models/") ? normalized : `models/${normalized}`
}

const GEMINI_RETRY_MAX_ATTEMPTS = 3
const GEMINI_RETRY_BASE_DELAY_MS = 500

function isRetryableGeminiStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function getGeminiRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!Number.isNaN(seconds)) return seconds * 1000
  }
  return GEMINI_RETRY_BASE_DELAY_MS * 2 ** attempt
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export async function* streamGeminiGenerateContent(params: {
  model: string
  body: GeminiGenerateContentRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): AsyncGenerator<GeminiStreamChunk, void> {
  const fetchImpl = params.fetchOverride ?? fetch
  const url = `${getGeminiBaseUrl()}/${getGeminiModelPath(params.model)}:streamGenerateContent?alt=sse`

  // Retry transient failures (429/5xx/connection errors) before any content
  // has streamed. The body is a plain JSON payload, so re-issuing the request
  // is safe. Mid-stream errors are NOT retried — content may already have
  // been delivered, and a duplicate prefix would corrupt the turn.
  let response: Response | null = null
  for (let attempt = 0; attempt < GEMINI_RETRY_MAX_ATTEMPTS; attempt++) {
    if (params.signal.aborted) throw params.signal.reason ?? new Error("Aborted")
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY || "",
        },
        body: JSON.stringify(params.body),
        signal: params.signal,
        ...getProxyFetchOptions({ forAnthropicAPI: false }),
      })
    } catch (error) {
      const isAbort =
        error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
      if (isAbort || attempt === GEMINI_RETRY_MAX_ATTEMPTS - 1) throw error
      await sleep(GEMINI_RETRY_BASE_DELAY_MS * 2 ** attempt, params.signal)
      continue
    }
    if (response.ok) break
    const body = await response.text()
    if (!isRetryableGeminiStatus(response.status) || attempt === GEMINI_RETRY_MAX_ATTEMPTS - 1) {
      throw new Error(
        `Gemini API request failed (${response.status} ${response.statusText}): ${body || "empty response body"}`,
      )
    }
    await sleep(getGeminiRetryDelayMs(response, attempt), params.signal)
  }

  if (!response?.ok) {
    throw new Error(`Gemini API request failed (${response?.status ?? "unknown"})`)
  }

  if (!response.body) {
    throw new Error("Gemini API returned no response body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, STREAM_DECODE_OPTS)
      const { frames, remaining } = parseSSEFrames(buffer)
      buffer = remaining

      for (const frame of frames) {
        if (!frame.data || frame.data === "[DONE]") continue
        try {
          yield JSON.parse(frame.data) as GeminiStreamChunk
        } catch (error) {
          throw new Error(`Failed to parse Gemini SSE payload: ${errorMessage(error)}`)
        }
      }
    }

    buffer += decoder.decode()
    const { frames } = parseSSEFrames(buffer)
    for (const frame of frames) {
      if (!frame.data || frame.data === "[DONE]") continue
      try {
        yield JSON.parse(frame.data) as GeminiStreamChunk
      } catch (error) {
        throw new Error(`Failed to parse trailing Gemini SSE payload: ${errorMessage(error)}`)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

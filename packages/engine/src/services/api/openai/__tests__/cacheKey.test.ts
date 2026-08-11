import { describe, expect, test } from "bun:test"
import { createOpenAIPromptCacheKey } from "../cacheKey.js"

describe("createOpenAIPromptCacheKey", () => {
  const base = {
    source: "zjusct",
    model: "gpt-5.6-luna",
    conversationId: "session-123",
  }

  test("is stable for the same conversation route", () => {
    expect(createOpenAIPromptCacheKey(base)).toBe(createOpenAIPromptCacheKey(base))
  })

  test("isolates source, model, and conversation routes", () => {
    const key = createOpenAIPromptCacheKey(base)
    expect(createOpenAIPromptCacheKey({ ...base, source: "other" })).not.toBe(key)
    expect(createOpenAIPromptCacheKey({ ...base, model: "gpt-5.6-terra" })).not.toBe(key)
    expect(createOpenAIPromptCacheKey({ ...base, conversationId: "agent-123" })).not.toBe(key)
  })

  test("does not expose route identifiers", () => {
    const key = createOpenAIPromptCacheKey(base)
    expect(key).toMatch(/^wren-[a-f0-9]{32}$/)
    expect(key).not.toContain(base.source)
    expect(key).not.toContain(base.model)
    expect(key).not.toContain(base.conversationId)
  })
})

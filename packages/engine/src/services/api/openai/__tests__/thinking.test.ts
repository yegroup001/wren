import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  buildOpenAIRequestBody,
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
} from "../requestBody.js"

// Re-register envUtils.js with correct isEnvDefinedFalsy and isEnvTruthy to
// override pollution from other test files (debug-tool-call, issue,
// break-cache, MagicDocs/prompts, SessionMemory/prompts, cacheStats) that
// mock this module without exporting isEnvDefinedFalsy.
mock.module("src/utils/envUtils.js", () => ({
  isEnvTruthy: (v: string | boolean | undefined): boolean => {
    if (!v) return false
    if (typeof v === "boolean") return v
    return ["1", "true", "yes", "on"].includes(v.toLowerCase().trim())
  },
  isEnvDefinedFalsy: (v: string | boolean | undefined): boolean => {
    if (v === undefined) return false
    if (typeof v === "boolean") return !v
    if (!v) return false
    return ["0", "false", "no", "off"].includes(v.toLowerCase().trim())
  },
}))

describe("isOpenAIThinkingEnabled", () => {
  const originalEnv = {
    OPENAI_ENABLE_THINKING: process.env.OPENAI_ENABLE_THINKING,
  }

  beforeEach(() => {
    // Clear env var before each test
    delete process.env.OPENAI_ENABLE_THINKING
  })

  afterEach(() => {
    // Restore original env var — delete key if it was originally undefined
    // to avoid leaking the env key into subsequent tests
    if (originalEnv.OPENAI_ENABLE_THINKING === undefined) {
      delete process.env.OPENAI_ENABLE_THINKING
    } else {
      process.env.OPENAI_ENABLE_THINKING = originalEnv.OPENAI_ENABLE_THINKING
    }
  })

  describe("OPENAI_ENABLE_THINKING env var", () => {
    test("returns true when OPENAI_ENABLE_THINKING=1", () => {
      process.env.OPENAI_ENABLE_THINKING = "1"
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(true)
    })

    test("returns true when OPENAI_ENABLE_THINKING=true", () => {
      process.env.OPENAI_ENABLE_THINKING = "true"
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(true)
    })

    test("returns true when OPENAI_ENABLE_THINKING=yes", () => {
      process.env.OPENAI_ENABLE_THINKING = "yes"
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(true)
    })

    test("returns true when OPENAI_ENABLE_THINKING=on", () => {
      process.env.OPENAI_ENABLE_THINKING = "on"
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(true)
    })

    test("returns true when OPENAI_ENABLE_THINKING=TRUE (case insensitive)", () => {
      process.env.OPENAI_ENABLE_THINKING = "TRUE"
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(true)
    })

    test("returns false when OPENAI_ENABLE_THINKING=0", () => {
      process.env.OPENAI_ENABLE_THINKING = "0"
      expect(isOpenAIThinkingEnabled("deepseek-reasoner")).toBe(false)
    })

    test("returns false when OPENAI_ENABLE_THINKING=false", () => {
      process.env.OPENAI_ENABLE_THINKING = "false"
      expect(isOpenAIThinkingEnabled("deepseek-reasoner")).toBe(false)
    })

    test("returns false when OPENAI_ENABLE_THINKING is empty", () => {
      process.env.OPENAI_ENABLE_THINKING = ""
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(false)
    })

    test("returns false when OPENAI_ENABLE_THINKING is not set", () => {
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(false)
    })
  })

  describe("model name auto-detect", () => {
    test('returns true when model name is "deepseek-reasoner"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-reasoner")).toBe(true)
    })

    test('returns true when model name contains "deepseek-reasoner" (case insensitive)', () => {
      expect(isOpenAIThinkingEnabled("DeepSeek-Reasoner")).toBe(true)
    })

    test("returns true when model name has prefix/suffix for deepseek-reasoner", () => {
      expect(isOpenAIThinkingEnabled("my-deepseek-reasoner-v1")).toBe(true)
    })

    test("returns true when model name is namespaced for deepseek-reasoner", () => {
      expect(isOpenAIThinkingEnabled("TokenService/deepseek-reasoner")).toBe(true)
    })

    test('returns true when model name is "deepseek-v3.2"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-v3.2")).toBe(true)
    })

    test('returns true when model name contains "deepseek-v3.2" (case insensitive)', () => {
      expect(isOpenAIThinkingEnabled("DeepSeek-V3.2")).toBe(true)
    })

    test("returns true when model name has prefix/suffix for deepseek-v3.2", () => {
      expect(isOpenAIThinkingEnabled("my-deepseek-v3.2-v1")).toBe(true)
    })

    test("returns true when model name is namespaced for deepseek-v3.2", () => {
      expect(isOpenAIThinkingEnabled("TokenService/deepseek-v3.2")).toBe(true)
    })

    test('returns true when model name is "deepseek-chat"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-chat")).toBe(true)
    })

    test('returns true when model name is "deepseek-v3"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-v3")).toBe(true)
    })

    test('returns true when model name is "deepseek-v4"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-v4")).toBe(true)
    })

    test('returns true when model name is "deepseek-v4-pro"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-v4-pro")).toBe(true)
    })

    test('returns true when model name is "deepseek-r1"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-r1")).toBe(true)
    })

    test('returns true when model name contains "deepseek"', () => {
      expect(isOpenAIThinkingEnabled("deepseek-coder")).toBe(true)
    })

    test('returns true when model name is "mimo-v2-flash"', () => {
      expect(isOpenAIThinkingEnabled("mimo-v2-flash")).toBe(true)
    })

    test('returns true when model name is "mimo-v2-pro"', () => {
      expect(isOpenAIThinkingEnabled("mimo-v2-pro")).toBe(true)
    })

    test('returns true when model name is "mimo-v2.5-pro"', () => {
      expect(isOpenAIThinkingEnabled("mimo-v2.5-pro")).toBe(true)
    })

    test('returns true when model name contains "mimo"', () => {
      expect(isOpenAIThinkingEnabled("MiMo-V2-Omni")).toBe(true)
    })

    test('returns false when model name is "gpt-4o"', () => {
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(false)
    })

    test("returns false when model name is empty", () => {
      expect(isOpenAIThinkingEnabled("")).toBe(false)
    })
  })

  describe("priority and combined detection", () => {
    test("OPENAI_ENABLE_THINKING=1 enables thinking for any model", () => {
      process.env.OPENAI_ENABLE_THINKING = "1"
      expect(isOpenAIThinkingEnabled("gpt-4o")).toBe(true)
      expect(isOpenAIThinkingEnabled("deepseek-v3")).toBe(true)
      expect(isOpenAIThinkingEnabled("qwen-3")).toBe(true)
    })

    test("OPENAI_ENABLE_THINKING=false disables thinking even for deepseek-reasoner", () => {
      process.env.OPENAI_ENABLE_THINKING = "false"
      expect(isOpenAIThinkingEnabled("deepseek-reasoner")).toBe(false)
    })

    test("OPENAI_ENABLE_THINKING=0 disables thinking even for deepseek-reasoner", () => {
      process.env.OPENAI_ENABLE_THINKING = "0"
      expect(isOpenAIThinkingEnabled("deepseek-reasoner")).toBe(false)
    })

    test("both conditions can enable thinking", () => {
      process.env.OPENAI_ENABLE_THINKING = "1"
      expect(isOpenAIThinkingEnabled("deepseek-reasoner")).toBe(true)
    })
  })
})

describe("request-scoped OpenAI configuration", () => {
  test("explicit thinking configuration takes precedence over environment state", () => {
    const previous = process.env.OPENAI_ENABLE_THINKING
    process.env.OPENAI_ENABLE_THINKING = "0"
    expect(isOpenAIThinkingEnabled("gpt-4o", true)).toBe(true)
    expect(isOpenAIThinkingEnabled("deepseek-reasoner", false)).toBe(false)
    if (previous === undefined) delete process.env.OPENAI_ENABLE_THINKING
    else process.env.OPENAI_ENABLE_THINKING = previous
  })

  test("configured output limit is used when no programmatic or OpenAI override exists", () => {
    const previousOpenAI = process.env.OPENAI_MAX_TOKENS
    const previousWren = process.env.WREN_MAX_OUTPUT_TOKENS
    delete process.env.OPENAI_MAX_TOKENS
    process.env.WREN_MAX_OUTPUT_TOKENS = "999"
    expect(resolveOpenAIMaxTokens(1000, undefined, 222, false)).toBe(222)
    expect(resolveOpenAIMaxTokens(1000, undefined, undefined, false)).toBe(1000)
    if (previousOpenAI === undefined) delete process.env.OPENAI_MAX_TOKENS
    else process.env.OPENAI_MAX_TOKENS = previousOpenAI
    if (previousWren === undefined) delete process.env.WREN_MAX_OUTPUT_TOKENS
    else process.env.WREN_MAX_OUTPUT_TOKENS = previousWren
  })
})

describe("buildOpenAIRequestBody — thinking params", () => {
  const baseParams = {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: undefined,
  }

  test("includes official DeepSeek API thinking format when enabled", () => {
    const body = buildOpenAIRequestBody({ ...baseParams, enableThinking: true })
    expect(body.thinking).toEqual({ type: "enabled" })
  })

  test("includes vLLM/self-hosted thinking format when enabled", () => {
    const body = buildOpenAIRequestBody({ ...baseParams, enableThinking: true })
    expect(body.enable_thinking).toBe(true)
    expect(body.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    })
  })

  test("includes both formats simultaneously when enabled", () => {
    const body = buildOpenAIRequestBody({ ...baseParams, enableThinking: true })
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.enable_thinking).toBe(true)
    expect(body.chat_template_kwargs?.thinking).toBe(true)
  })

  test("does NOT include thinking params when disabled", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: false,
    })
    expect(body.thinking).toBeUndefined()
    expect(body.enable_thinking).toBeUndefined()
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  test("always includes stream and stream_options", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: false,
    })
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  test("adds a prompt cache key when provided", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: false,
      promptCacheKey: "wren-cache-key",
    })
    expect(body.prompt_cache_key).toBe("wren-cache-key")
  })

  test("omits a prompt cache key when not provided", () => {
    const body = buildOpenAIRequestBody({ ...baseParams, enableThinking: false })
    expect(body.prompt_cache_key).toBeUndefined()
  })

  test("includes temperature when thinking is off and override is set", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: false,
      temperatureOverride: 0.7,
    })
    expect(body.temperature).toBe(0.7)
  })

  test("excludes temperature when thinking is on even if override is set", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: true,
      temperatureOverride: 0.7,
    })
    expect(body.temperature).toBeUndefined()
  })

  test("excludes temperature when thinking is off and no override", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: false,
    })
    expect(body.temperature).toBeUndefined()
  })

  test("includes tools and tool_choice when tools are provided", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      tools: [{ type: "function", function: { name: "test" } }],
      toolChoice: "auto",
      enableThinking: false,
    })
    expect(body.tools).toHaveLength(1)
    expect(body.tool_choice).toBe("auto")
  })

  test("excludes tools when empty", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: false,
    })
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })
})

describe("buildOpenAIRequestBody — reasoning_effort", () => {
  const baseParams = {
    model: "gpt-5.6-terra",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: undefined,
    enableThinking: false,
  }

  test("includes reasoning_effort when provided", () => {
    const body = buildOpenAIRequestBody({ ...baseParams, reasoningEffort: "high" })
    expect(body.reasoning_effort).toBe("high")
  })

  test("includes reasoning_effort alongside thinking params", () => {
    const body = buildOpenAIRequestBody({
      ...baseParams,
      enableThinking: true,
      reasoningEffort: "xhigh",
    })
    expect(body.reasoning_effort).toBe("xhigh")
    expect(body.thinking).toEqual({ type: "enabled" })
  })

  test("omits reasoning_effort when undefined", () => {
    const body = buildOpenAIRequestBody({ ...baseParams })
    expect(body.reasoning_effort).toBeUndefined()
  })

  test("omits reasoning_effort when empty string", () => {
    const body = buildOpenAIRequestBody({ ...baseParams, reasoningEffort: "" })
    expect(body.reasoning_effort).toBeUndefined()
  })
})

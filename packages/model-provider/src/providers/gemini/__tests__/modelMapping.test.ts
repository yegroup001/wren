import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveGeminiModel } from "../modelMapping.js"

describe("resolveGeminiModel", () => {
  const originalEnv = {
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_DEFAULT_HAIKU_MODEL: process.env.GEMINI_DEFAULT_HAIKU_MODEL,
    GEMINI_DEFAULT_SONNET_MODEL: process.env.GEMINI_DEFAULT_SONNET_MODEL,
    GEMINI_DEFAULT_OPUS_MODEL: process.env.GEMINI_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  }

  beforeEach(() => {
    delete process.env.GEMINI_MODEL
    delete process.env.GEMINI_DEFAULT_HAIKU_MODEL
    delete process.env.GEMINI_DEFAULT_SONNET_MODEL
    delete process.env.GEMINI_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  })

  afterEach(() => {
    Object.assign(process.env, originalEnv)
  })

  test("GEMINI_MODEL env var overrides everything", () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro"
    process.env.GEMINI_DEFAULT_SONNET_MODEL = "gemini-2.5-flash"

    expect(resolveGeminiModel("claude-sonnet-4-6")).toBe("gemini-2.5-pro")
  })

  test("resolves sonnet model from GEMINI_DEFAULT_SONNET_MODEL", () => {
    process.env.GEMINI_DEFAULT_SONNET_MODEL = "gemini-2.5-flash"
    expect(resolveGeminiModel("claude-sonnet-4-6")).toBe("gemini-2.5-flash")
  })

  test("resolves haiku model from GEMINI_DEFAULT_HAIKU_MODEL", () => {
    process.env.GEMINI_DEFAULT_HAIKU_MODEL = "gemini-2.5-flash-lite"
    expect(resolveGeminiModel("claude-haiku-4-5-20251001")).toBe("gemini-2.5-flash-lite")
  })

  test("resolves opus model from GEMINI_DEFAULT_OPUS_MODEL", () => {
    process.env.GEMINI_DEFAULT_OPUS_MODEL = "gemini-2.5-pro"
    expect(resolveGeminiModel("claude-opus-4-6")).toBe("gemini-2.5-pro")
  })

  test("ANTHROPIC_DEFAULT_* env vars are ignored (cross-provider fallback removed)", () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-2.5-flash"
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "gemini-2.5-flash-lite"
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "gemini-2.5-pro"
    expect(() => resolveGeminiModel("claude-sonnet-4-6")).toThrow()
    expect(() => resolveGeminiModel("claude-haiku-4-5-20251001")).toThrow()
    expect(() => resolveGeminiModel("claude-opus-4-6")).toThrow()
  })

  test("strips [1m] suffix before resolving", () => {
    process.env.GEMINI_DEFAULT_SONNET_MODEL = "gemini-2.5-flash"
    expect(resolveGeminiModel("claude-sonnet-4-6[1m]")).toBe("gemini-2.5-flash")
  })

  test("passes through explicit (non-tier) model names", () => {
    expect(resolveGeminiModel("gemini-3.1-flash-lite-preview")).toBe(
      "gemini-3.1-flash-lite-preview",
    )
  })

  test("throws when no Gemini model configuration is available", () => {
    expect(() => resolveGeminiModel("claude-sonnet-4-6")).toThrow(
      "Gemini provider requires GEMINI_MODEL or GEMINI_DEFAULT_SONNET_MODEL to be configured.",
    )
  })
})

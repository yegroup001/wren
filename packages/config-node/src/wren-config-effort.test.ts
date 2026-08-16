import { describe, expect, test } from "bun:test"
import { WrenConfigSchema } from "./index"

function makeSource(type: string, models: Record<string, unknown>) {
  return { type, baseUrl: "https://example.invalid/v1", apiKey: "test-key", models }
}

function makeModel(overrides: Record<string, unknown> = {}) {
  return { contextWindow: 128000, supportsThinking: true, ...overrides }
}

function _makeConfig(sourceName: string, models: Record<string, unknown>) {
  const firstModel = Object.keys(models)[0] ?? "test-model"
  return {
    defaultModel: { source: sourceName, model: firstModel },
    sources: {
      [sourceName]: makeSource(
        models[firstModel]?.toString().includes("gemini")
          ? "gemini"
          : models[firstModel]?.toString().includes("anthropic")
            ? "anthropic"
            : models[firstModel]?.toString().includes("grok")
              ? "grok"
              : "openai-compatible-chat",
        models,
      ),
    },
  }
}

// Helper to build a config with a specific provider type and model overrides
function buildConfig(
  providerType: string,
  modelId: string,
  overrides: Record<string, unknown> = {},
) {
  const sourceName =
    providerType === "anthropic"
      ? "anthropic-src"
      : providerType === "gemini"
        ? "gemini-src"
        : providerType === "grok"
          ? "grok-src"
          : providerType === "openai-official"
            ? "openai-src"
            : "compat-src"
  return {
    defaultModel: { source: sourceName, model: modelId },
    sources: {
      [sourceName]: makeSource(providerType, { [modelId]: makeModel(overrides) }),
    },
  }
}

describe("WrenModelSchema effort/thinking validation", () => {
  // --- Valid configurations ---

  test("accepts effort + efforts for openai-compatible-chat", () => {
    const config = buildConfig("openai-compatible-chat", "glm-5.2", {
      effort: "high",
      efforts: ["low", "medium", "high"],
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts effort without efforts (derives from provider kind)", () => {
    const config = buildConfig("openai-official", "gpt-4o", { effort: "medium" })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts thinkingBudget for gemini", () => {
    const config = buildConfig("gemini", "gemini-pro", { thinkingBudget: 24576 })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts reasoningMode adaptive for anthropic", () => {
    const config = buildConfig("anthropic", "claude-sonnet", { reasoningMode: "adaptive" })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts reasoningMode budget with budgetTokens for anthropic", () => {
    const config = buildConfig("anthropic", "claude-opus", {
      reasoningMode: "budget",
      budgetTokens: 8192,
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts enableThinking for openai-compatible-chat", () => {
    const config = buildConfig("openai-compatible-chat", "deepseek-r1", { enableThinking: true })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts no thinking fields when supportsThinking is false", () => {
    const config = buildConfig("openai-official", "gpt-4o", { supportsThinking: false })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test("accepts effort for grok provider kind", () => {
    const config = buildConfig("grok", "grok-2", { effort: "high" })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  // --- Invalid configurations ---

  test("rejects effort for gemini (wrong mechanism)", () => {
    const config = buildConfig("gemini", "gemini-pro", { effort: "high" })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects thinkingBudget for anthropic (wrong mechanism)", () => {
    const config = buildConfig("anthropic", "claude-sonnet", { thinkingBudget: 8192 })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects reasoningMode for openai-compatible-chat (wrong mechanism)", () => {
    const config = buildConfig("openai-official", "gpt-4o", { reasoningMode: "adaptive" })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects enableThinking for anthropic (wrong provider kind)", () => {
    const config = buildConfig("anthropic", "claude-sonnet", { enableThinking: true })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects enableThinking and effort together (mutually exclusive)", () => {
    const config = buildConfig("openai-compatible-chat", "deepseek-r1", {
      enableThinking: true,
      effort: "high",
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects effort not in efforts array", () => {
    const config = buildConfig("openai-official", "gpt-4o", {
      effort: "max",
      efforts: ["low", "medium", "high"],
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects thinking fields when supportsThinking is false", () => {
    const config = buildConfig("openai-official", "gpt-4o", {
      supportsThinking: false,
      effort: "high",
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects budgetTokens without reasoningMode budget for anthropic", () => {
    const config = buildConfig("anthropic", "claude-sonnet", {
      reasoningMode: "adaptive",
      budgetTokens: 8192,
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects effort for anthropic (wrong mechanism)", () => {
    const config = buildConfig("anthropic", "claude-sonnet", { effort: "high" })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects thinkingBudget for openai-compatible-chat (wrong mechanism)", () => {
    const config = buildConfig("openai-official", "gpt-4o", { thinkingBudget: 8192 })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects enableThinking for gemini (wrong provider kind)", () => {
    const config = buildConfig("gemini", "gemini-pro", { enableThinking: true })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects budgetTokens for effort-levels provider kind", () => {
    const config = buildConfig("openai-official", "gpt-4o", { effort: "high", budgetTokens: 8192 })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects budgetTokens for thinking-budget provider kind", () => {
    const config = buildConfig("gemini", "gemini-pro", {
      thinkingBudget: 24576,
      budgetTokens: 8192,
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects budgetTokens for thinking-toggle provider kind", () => {
    const config = buildConfig("openai-compatible-chat", "deepseek-r1", {
      enableThinking: true,
      budgetTokens: 8192,
    })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test("rejects empty efforts array", () => {
    const config = buildConfig("openai-official", "gpt-4o", { supportsThinking: true, efforts: [] })
    const result = WrenConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })
})

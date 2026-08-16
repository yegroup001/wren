import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WrenConfig } from "@wren/config-node"
import { clearOpenAIClientCache, getOpenAIClient } from "../../../services/api/openai/client"
import {
  applyModelConfigToEnv,
  getModelEffort,
  getModelEfforts,
  getModelProviderKind,
  initConfig,
  modelUsesEffortLevels,
  resolveModelConfig,
  resolveModelReference,
  setConfigForTests,
} from "../configBridge"

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "WREN_USE_OPENAI",
  "OPENAI_MODEL",
  "OPENAI_SMALL_FAST_MODEL",
  "WREN_MAX_OUTPUT_TOKENS",
  "WREN_MAX_CONTEXT_TOKENS",
  "OPENAI_ENABLE_THINKING",
] as const

const savedEnv = new Map<string, string | undefined>()

function saveEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  setConfigForTests(null)
  clearOpenAIClientCache()
}

const config: WrenConfig = {
  defaultModel: { source: "llmapi-ext", model: "glm-5.2" },
  sources: {
    "llmapi-ext": {
      type: "openai-compatible-chat",
      baseUrl: "https://llmapi.example/v1",
      apiKey: "llmapi-key",
      models: {
        "glm-5.2": {
          contextWindow: 1048576,
          maxOutputTokens: 131072,
          displayName: "GLM-5.2",
          supportsThinking: true,
        },
        "deepseek-r1": {
          contextWindow: 64000,
          displayName: "DeepSeek R1",
          supportsThinking: true,
          enableThinking: true,
        },
      },
    },
    zjusct: {
      type: "openai-compatible-chat",
      baseUrl: "https://newapi.s.zjusct.io/v1",
      apiKey: "zjusct-key",
      models: {
        "gpt-5.6-terra": {
          contextWindow: 372000,
          maxOutputTokens: 128000,
          displayName: "GPT-5.6-Terra",
          supportsThinking: true,
          effort: "high",
          efforts: ["low", "medium", "high"],
        },
        "gpt-4o-nothink": {
          contextWindow: 128000,
          displayName: "GPT-4o",
          supportsThinking: false,
        },
      },
    },
    anthropic: {
      type: "anthropic",
      apiKey: "ant-key",
      models: {
        "claude-sonnet": {
          contextWindow: 200000,
          displayName: "Claude Sonnet",
          supportsThinking: true,
          reasoningMode: "adaptive",
        },
      },
    },
    gemini: {
      type: "gemini",
      apiKey: "gem-key",
      models: {
        "gemini-pro": {
          contextWindow: 1048576,
          displayName: "Gemini Pro",
          supportsThinking: true,
          thinkingBudget: 24576,
        },
      },
    },
  },
}

describe("configBridge", () => {
  afterEach(restoreEnv)

  test("resolves a qualified source/model reference", () => {
    expect(resolveModelReference(config, "zjusct/gpt-5.6-terra")).toEqual({
      source: "zjusct",
      model: "gpt-5.6-terra",
    })
  })

  test("preserves an object model reference", () => {
    const reference = { source: "zjusct", model: "gpt-5.6-terra" } as const
    expect(resolveModelReference(config, reference)).toBe(reference)
  })

  test("resolves provider and model settings without mutating the environment", () => {
    saveEnv()
    setConfigForTests(config)
    const before = { ...process.env }

    const resolved = resolveModelConfig("zjusct/gpt-5.6-terra")

    expect(resolved.reference).toEqual({ source: "zjusct", model: "gpt-5.6-terra" })
    expect(resolved.source.apiKey).toBe("zjusct-key")
    expect(resolved.source.baseUrl).toBe("https://newapi.s.zjusct.io/v1")
    expect(resolved.model.maxOutputTokens).toBe(128000)
    expect({ ...process.env }).toEqual(before)
  })

  test("rejects a bare model reference", () => {
    expect(() => resolveModelReference(config, "gpt-5.6-terra")).toThrow(
      "must use <source>/<model>",
    )
  })

  test("applies the selected model provider instead of the default provider", () => {
    // Given: the default model belongs to llmapi-ext, but the selected model belongs to zjusct.
    saveEnv()
    setConfigForTests(config)

    // When: runtime env is applied for the selected GPT-5.6 model.
    applyModelConfigToEnv("zjusct/gpt-5.6-terra")

    // Then: OpenAI-compatible requests use zjusct credentials and model limits.
    expect(process.env.OPENAI_API_KEY).toBe("zjusct-key")
    expect(process.env.OPENAI_BASE_URL).toBe("https://newapi.s.zjusct.io/v1")
    expect(process.env.WREN_USE_OPENAI).toBe("1")
    expect(process.env.WREN_MAX_CONTEXT_TOKENS).toBe("372000")
    expect(process.env.WREN_MAX_OUTPUT_TOKENS).toBe("128000")
    expect(process.env.OPENAI_ENABLE_THINKING).toBe("1")
  })

  test("clears the cached OpenAI client when the selected provider changes", () => {
    // Given: an OpenAI-compatible client has already been created for the default provider.
    saveEnv()
    setConfigForTests(config)
    applyModelConfigToEnv("llmapi-ext/glm-5.2")
    const defaultClient = getOpenAIClient()

    // When: runtime env switches to a model backed by a different provider.
    applyModelConfigToEnv("zjusct/gpt-5.6-terra")
    const selectedClient = getOpenAIClient()

    // Then: requests cannot reuse the stale client bound to the default provider.
    expect(selectedClient).not.toBe(defaultClient)
  })

  test("initializes env from the default model provider", async () => {
    // Given: a config file whose default model belongs to llmapi-ext.
    saveEnv()
    const dir = await mkdtemp(join(tmpdir(), "wren-config-bridge-"))
    const configPath = join(dir, "config.json")
    await writeFile(configPath, JSON.stringify(config), "utf8")

    // When: config is initialized from disk.
    await initConfig(configPath)

    // Then: startup env uses the default model provider without requiring a prior loaded config.
    expect(process.env.OPENAI_API_KEY).toBe("llmapi-key")
    expect(process.env.OPENAI_BASE_URL).toBe("https://llmapi.example/v1")
    expect(process.env.WREN_MAX_CONTEXT_TOKENS).toBe("1048576")
  })

  test("getModelEfforts returns explicit efforts when specified", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEfforts("zjusct/gpt-5.6-terra")).toEqual(["low", "medium", "high"])
  })

  test("getModelEfforts derives all levels when efforts omitted and provider uses effort-levels", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEfforts("llmapi-ext/glm-5.2")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("getModelEfforts returns empty for models with enableThinking (thinking-toggle)", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEfforts("llmapi-ext/deepseek-r1")).toEqual([])
  })

  test("getModelEfforts returns empty for anthropic (reasoning-mode)", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEfforts("anthropic/claude-sonnet")).toEqual([])
  })

  test("getModelEfforts returns empty for gemini (thinking-budget)", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEfforts("gemini/gemini-pro")).toEqual([])
  })

  test("getModelEfforts returns empty when supportsThinking is false", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEfforts("zjusct/gpt-4o-nothink")).toEqual([])
  })

  test("modelUsesEffortLevels returns true for effort-levels models", () => {
    saveEnv()
    setConfigForTests(config)
    expect(modelUsesEffortLevels("llmapi-ext/glm-5.2")).toBe(true)
    expect(modelUsesEffortLevels("zjusct/gpt-5.6-terra")).toBe(true)
  })

  test("modelUsesEffortLevels returns false for thinking-toggle models", () => {
    saveEnv()
    setConfigForTests(config)
    expect(modelUsesEffortLevels("llmapi-ext/deepseek-r1")).toBe(false)
  })

  test("modelUsesEffortLevels returns false for reasoning-mode models", () => {
    saveEnv()
    setConfigForTests(config)
    expect(modelUsesEffortLevels("anthropic/claude-sonnet")).toBe(false)
  })

  test("modelUsesEffortLevels returns false for thinking-budget models", () => {
    saveEnv()
    setConfigForTests(config)
    expect(modelUsesEffortLevels("gemini/gemini-pro")).toBe(false)
  })

  test("getModelProviderKind returns the provider kind for a model", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelProviderKind("llmapi-ext/glm-5.2")).toBe("openai-compatible-chat")
    expect(getModelProviderKind("anthropic/claude-sonnet")).toBe("anthropic")
    expect(getModelProviderKind("gemini/gemini-pro")).toBe("gemini")
  })

  test("getModelEffort returns the default effort for a model", () => {
    saveEnv()
    setConfigForTests(config)
    expect(getModelEffort("zjusct/gpt-5.6-terra")).toBe("high")
    expect(getModelEffort("llmapi-ext/glm-5.2")).toBeUndefined()
  })

  test("OPENAI_ENABLE_THINKING uses enableThinking when set", () => {
    saveEnv()
    setConfigForTests(config)
    applyModelConfigToEnv("llmapi-ext/deepseek-r1")
    expect(process.env.OPENAI_ENABLE_THINKING).toBe("1")
  })

  test("OPENAI_ENABLE_THINKING falls back to supportsThinking when enableThinking not set", () => {
    saveEnv()
    setConfigForTests(config)
    applyModelConfigToEnv("zjusct/gpt-4o-nothink")
    expect(process.env.OPENAI_ENABLE_THINKING).toBe("0")
  })
})

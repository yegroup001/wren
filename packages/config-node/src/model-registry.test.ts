import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUILT_IN_MODEL_ENTRIES,
  loadModelRegistry,
  parseGrokModelMap,
  setWrenConfigHomeForTests,
} from "./index"

describe("Todo 5: model registry parser with diagnostics", () => {
  test("built-in entries have 7 models", () => {
    expect(BUILT_IN_MODEL_ENTRIES).toHaveLength(7)
  })

  test("built-in entries include nested-slash-safe modelIds", () => {
    const ids = BUILT_IN_MODEL_ENTRIES.map((e) => e.ref.modelId)
    expect(ids).toContain("glm-5.2")
    expect(ids).toContain("claude-sonnet-4-5")
  })

  test("returns built-in catalog with info diagnostic when no config exists", () => {
    const result = loadModelRegistry("/tmp/opencode/nonexistent-path-12345", {
      skipGlobalConfig: true,
    })
    expect(result.source).toBe("built-in")
    expect(result.entries).toHaveLength(7)
    expect(
      result.diagnostics.some((d) => d.level === "info" && d.message.includes("No config")),
    ).toBe(true)
  })

  test("returns built-in when skipGlobalConfig is true", () => {
    const result = loadModelRegistry("/tmp", { skipGlobalConfig: true })
    expect(result.source).toBe("built-in")
    expect(result.diagnostics).toHaveLength(1)
  })

  test("parseGrokModelMap returns null for undefined", () => {
    expect(parseGrokModelMap(undefined)).toBeNull()
  })

  test("parseGrokModelMap returns null for invalid JSON", () => {
    expect(parseGrokModelMap("not-json")).toBeNull()
  })

  test("parseGrokModelMap returns null for non-object JSON", () => {
    expect(parseGrokModelMap("[1,2,3]")).toBeNull()
  })

  test("parseGrokModelMap returns null for object with non-string values", () => {
    expect(parseGrokModelMap('{"opus":123}')).toBeNull()
  })

  test("parseGrokModelMap parses valid Record<string,string>", () => {
    const result = parseGrokModelMap('{"opus":"grok-4","sonnet":"grok-3"}')
    expect(result).not.toBeNull()
    expect(result?.opus).toBe("grok-4")
    expect(result?.sonnet).toBe("grok-3")
  })
})

describe("model registry thinking metadata", () => {
  test("projects effort levels for effort-levels provider kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-registry-thinking-"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        defaultModel: { source: "llm", model: "glm-5.2" },
        smallFastModel: { source: "llm", model: "glm-5.2" },
        sources: {
          llm: {
            type: "openai-compatible-chat",
            baseUrl: "https://example.invalid/v1",
            apiKey: "key",
            models: {
              "glm-5.2": {
                contextWindow: 128000,
                supportsThinking: true,
                effort: "high",
                efforts: ["low", "medium", "high"],
              },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(root)
    try {
      const result = loadModelRegistry("/tmp")
      const entry = result.entries.find((e) => e.ref.modelId === "glm-5.2")
      expect(entry).toBeDefined()
      expect(entry?.reasoningMechanism).toBe("effort-levels")
      expect(entry?.efforts).toEqual(["low", "medium", "high"])
      expect(entry?.defaultEffort).toBe("high")
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("derives effort levels from provider kind when efforts omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-registry-derive-"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        defaultModel: { source: "openai", model: "gpt-4o" },
        smallFastModel: { source: "openai", model: "gpt-4o" },
        sources: {
          openai: {
            type: "openai-official",
            apiKey: "key",
            models: {
              "gpt-4o": {
                contextWindow: 128000,
                supportsThinking: true,
              },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(root)
    try {
      const result = loadModelRegistry("/tmp")
      const entry = result.entries.find((e) => e.ref.modelId === "gpt-4o")
      expect(entry?.reasoningMechanism).toBe("effort-levels")
      expect(entry?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("projects thinkingBudget for gemini", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-registry-gemini-"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        defaultModel: { source: "gemini", model: "gemini-pro" },
        smallFastModel: { source: "gemini", model: "gemini-pro" },
        sources: {
          gemini: {
            type: "gemini",
            apiKey: "key",
            models: {
              "gemini-pro": {
                contextWindow: 1048576,
                supportsThinking: true,
                thinkingBudget: 24576,
              },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(root)
    try {
      const result = loadModelRegistry("/tmp")
      const entry = result.entries.find((e) => e.ref.modelId === "gemini-pro")
      expect(entry?.reasoningMechanism).toBe("thinking-budget")
      expect(entry?.thinkingBudget).toBe(24576)
      expect(entry?.efforts).toBeUndefined()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("projects reasoningMode for anthropic", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-registry-anthropic-"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        defaultModel: { source: "anthropic", model: "claude-sonnet" },
        smallFastModel: { source: "anthropic", model: "claude-sonnet" },
        sources: {
          anthropic: {
            type: "anthropic",
            apiKey: "key",
            models: {
              "claude-sonnet": {
                contextWindow: 200000,
                supportsThinking: true,
                reasoningMode: "budget",
                budgetTokens: 8192,
              },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(root)
    try {
      const result = loadModelRegistry("/tmp")
      const entry = result.entries.find((e) => e.ref.modelId === "claude-sonnet")
      expect(entry?.reasoningMechanism).toBe("reasoning-mode")
      expect(entry?.reasoningMode).toBe("budget")
      expect(entry?.budgetTokens).toBe(8192)
      expect(entry?.efforts).toBeUndefined()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("projects enableThinking for openai-compatible-chat toggle models", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-registry-toggle-"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        defaultModel: { source: "ds", model: "deepseek-r1" },
        smallFastModel: { source: "ds", model: "deepseek-r1" },
        sources: {
          ds: {
            type: "openai-compatible-chat",
            baseUrl: "https://example.invalid/v1",
            apiKey: "key",
            models: {
              "deepseek-r1": {
                contextWindow: 64000,
                supportsThinking: true,
                enableThinking: true,
              },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(root)
    try {
      const result = loadModelRegistry("/tmp")
      const entry = result.entries.find((e) => e.ref.modelId === "deepseek-r1")
      expect(entry?.reasoningMechanism).toBe("thinking-toggle")
      expect(entry?.enableThinking).toBe(true)
      expect(entry?.efforts).toBeUndefined()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("no thinking metadata when supportsThinking is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-registry-nothinking-"))
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        defaultModel: { source: "openai", model: "gpt-4o" },
        smallFastModel: { source: "openai", model: "gpt-4o" },
        sources: {
          openai: {
            type: "openai-official",
            apiKey: "key",
            models: {
              "gpt-4o": {
                contextWindow: 128000,
                supportsThinking: false,
              },
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(root)
    try {
      const result = loadModelRegistry("/tmp")
      const entry = result.entries.find((e) => e.ref.modelId === "gpt-4o")
      expect(entry?.reasoningMechanism).toBe("none")
      expect(entry?.efforts).toBeUndefined()
      expect(entry?.defaultEffort).toBeUndefined()
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })
})

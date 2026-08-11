import { describe, expect, test } from "bun:test"
import { isModelCommand, parseModelCommand } from "./model-command"

describe("unified /models command parser", () => {
  test("/models → { verb: open }", () => {
    const cmd = parseModelCommand("/models")
    expect(cmd.verb).toBe("open")
  })

  test("/models source/model → { verb: set, ref: { providerId: source, modelId: model }, scope: session }", () => {
    const cmd = parseModelCommand("/models openai-compatible/gpt-5.5")
    expect(cmd.verb).toBe("set")
    if (cmd.verb === "set") {
      expect(cmd.ref.providerId).toBe("openai-compatible")
      expect(cmd.ref.modelId).toBe("gpt-5.5")
      expect(cmd.scope).toBe("session")
    }
  })

  test("/models anthropic/claude-sonnet-4-5 → nested provider:modelId split", () => {
    const cmd = parseModelCommand("/models anthropic/claude-sonnet-4-5")
    expect(cmd.verb).toBe("set")
    if (cmd.verb === "set") {
      expect(cmd.ref.providerId).toBe("anthropic")
      expect(cmd.ref.modelId).toBe("claude-sonnet-4-5")
    }
  })

  test("/models openrouter/anthropic/claude-sonnet → keeps nested slashes in modelId", () => {
    const cmd = parseModelCommand("/models openrouter/anthropic/claude-sonnet")
    expect(cmd.verb).toBe("set")
    if (cmd.verb === "set") {
      expect(cmd.ref.providerId).toBe("openrouter")
      expect(cmd.ref.modelId).toBe("anthropic/claude-sonnet")
    }
  })

  test("/models set source/model --project → { verb: set, scope: workspace }", () => {
    const cmd = parseModelCommand("/models set openai-compatible/glm-5.2 --project")
    expect(cmd.verb).toBe("set")
    if (cmd.verb === "set") {
      expect(cmd.ref.modelId).toBe("glm-5.2")
      expect(cmd.scope).toBe("workspace")
    }
  })

  test("/models set source/model --session → { verb: set, scope: session }", () => {
    const cmd = parseModelCommand("/models set openai-compatible/gpt-5.5 --session")
    expect(cmd.verb).toBe("set")
    if (cmd.verb === "set") {
      expect(cmd.scope).toBe("session")
    }
  })

  test("/models list → { verb: list }", () => {
    const cmd = parseModelCommand("/models list")
    expect(cmd.verb).toBe("list")
  })

  test("/models status → { verb: status }", () => {
    const cmd = parseModelCommand("/models status")
    expect(cmd.verb).toBe("status")
  })

  test("/models test source/model → { verb: test, ref: ... }", () => {
    const cmd = parseModelCommand("/models test openai-compatible/gpt-5.5")
    expect(cmd.verb).toBe("test")
    if (cmd.verb === "test") {
      expect(cmd.ref.modelId).toBe("gpt-5.5")
    }
  })

  test("isModelCommand identifies /models", () => {
    expect(isModelCommand("/models")).toBe(true)
    expect(isModelCommand("/models openai-compatible/gpt-5.5")).toBe(true)
  })

  test("isModelCommand rejects non-model commands", () => {
    expect(isModelCommand("/help")).toBe(false)
    expect(isModelCommand("/clear")).toBe(false)
    expect(isModelCommand("hello")).toBe(false)
    expect(isModelCommand("/model")).toBe(false)
    expect(isModelCommand("/mo")).toBe(false)
  })

  test("/models set with no id throws", () => {
    expect(() => parseModelCommand("/models set")).toThrow()
  })

  test("/models test with no id throws", () => {
    expect(() => parseModelCommand("/models test")).toThrow()
  })

  test("/models set with invalid scope throws", () => {
    expect(() => parseModelCommand("/models set openai-compatible/gpt-5.5 --global")).toThrow()
  })

  test("non-models command throws", () => {
    expect(() => parseModelCommand("/help")).toThrow()
    expect(() => parseModelCommand("/model")).toThrow()
  })

  test("bare model id in implicit set is rejected with source/model guidance", () => {
    expect(() => parseModelCommand("/models gpt-5.5")).toThrow("must use <source>/<model>")
  })

  test("bare model id in set verb is rejected with source/model guidance", () => {
    expect(() => parseModelCommand("/models set gpt-5.5")).toThrow("must use <source>/<model>")
  })

  test("bare model id in test verb is rejected with source/model guidance", () => {
    expect(() => parseModelCommand("/models test gpt-5.5")).toThrow("must use <source>/<model>")
  })
})

import { describe, expect, test } from "bun:test"
import {
  MODEL_SCOPES,
  MODEL_SOURCES,
  ModelRefSchema,
  ModelScopeSchema,
  ModelSelectionSchema,
  ModelSourceSchema,
  ProviderIdentitySchema,
  ReasoningOptionsSchema,
  VERIFIED_STATES,
  VerifiedStateSchema,
} from "./model-contract"

describe("Todo 1: ModelRef / ModelSelection / ModelScope / ModelSource / VerifiedState", () => {
  test("parses a ModelRef with simple modelId", () => {
    const ref = ModelRefSchema.parse({
      providerId: "openai-compatible",
      modelId: "gpt-5.5",
    })

    expect(ref.providerId).toBe("openai-compatible")
    expect(ref.modelId).toBe("gpt-5.5")
  })

  test("parses a ModelRef with nested-slash modelId (openrouter/anthropic/claude-sonnet)", () => {
    const ref = ModelRefSchema.parse({
      providerId: "openai-compatible",
      modelId: "openrouter/anthropic/claude-sonnet",
      displayName: "Claude Sonnet via OpenRouter",
    })

    expect(ref.modelId).toBe("openrouter/anthropic/claude-sonnet")
    expect(ref.displayName).toBe("Claude Sonnet via OpenRouter")
  })

  test("rejects ModelRef with empty modelId", () => {
    const result = ModelRefSchema.safeParse({
      providerId: "openai-compatible",
      modelId: "",
    })

    expect(result.success).toBe(false)
  })

  test("rejects ModelRef with empty providerId", () => {
    const result = ModelRefSchema.safeParse({
      providerId: "",
      modelId: "gpt-5.5",
    })

    expect(result.success).toBe(false)
  })

  test("all ModelScope values are covered", () => {
    expect(MODEL_SCOPES).toEqual(["turn", "session", "workspace", "user"])
    for (const scope of MODEL_SCOPES) {
      expect(ModelScopeSchema.parse(scope)).toBe(scope)
    }
  })

  test("all ModelSource values are covered", () => {
    expect(MODEL_SOURCES).toEqual([
      "slash-command",
      "picker",
      "cli",
      "session",
      "workspace-config",
      "user-config",
      "env",
      "builtin",
    ])
    for (const source of MODEL_SOURCES) {
      expect(ModelSourceSchema.parse(source)).toBe(source)
    }
  })

  test("all VerifiedState values are covered", () => {
    expect(VERIFIED_STATES).toEqual(["unverified", "probe-ok", "probe-failed", "request-ok"])
    for (const state of VERIFIED_STATES) {
      expect(VerifiedStateSchema.parse(state)).toBe(state)
    }
  })

  test("rejects unknown ModelScope", () => {
    expect(ModelScopeSchema.safeParse("global").success).toBe(false)
  })

  test("rejects unknown ModelSource", () => {
    expect(ModelSourceSchema.safeParse("auto").success).toBe(false)
  })

  test("parses a full ModelSelection without reasoning", () => {
    const sel = ModelSelectionSchema.parse({
      ref: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      scope: "session",
      source: "picker",
      verified: "unverified",
    })

    expect(sel.scope).toBe("session")
    expect(sel.verified).toBe("unverified")
  })

  test("parses a full ModelSelection with reasoning", () => {
    const sel = ModelSelectionSchema.parse({
      ref: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      scope: "workspace",
      source: "workspace-config",
      reasoning: { kind: "anthropic", mode: "adaptive" },
      verified: "unverified",
    })

    expect(sel.reasoning?.kind).toBe("anthropic")
  })
})

describe("Todo 2: ReasoningOptions / ProviderKind / ProviderIdentity", () => {
  test("ReasoningOptions: none variant", () => {
    const r = ReasoningOptionsSchema.parse({ kind: "none" })
    expect(r.kind).toBe("none")
  })

  test("ReasoningOptions: anthropic adaptive variant", () => {
    const r = ReasoningOptionsSchema.parse({ kind: "anthropic", mode: "adaptive" })
    expect(r.kind).toBe("anthropic")
    if (r.kind === "anthropic") {
      expect(r.mode).toBe("adaptive")
    }
  })

  test("ReasoningOptions: anthropic budget variant with budgetTokens", () => {
    const r = ReasoningOptionsSchema.parse({
      kind: "anthropic",
      mode: "budget",
      budgetTokens: 8192,
    })
    if (r.kind === "anthropic" && r.mode === "budget") {
      expect(r.budgetTokens).toBe(8192)
    }
  })

  test("ReasoningOptions: openai-responses variant with effort", () => {
    const r = ReasoningOptionsSchema.parse({
      kind: "openai-responses",
      effort: "high",
    })
    if (r.kind === "openai-responses") {
      expect(r.effort).toBe("high")
    }
  })

  test("ReasoningOptions: openai-chat-vendor variant", () => {
    const r = ReasoningOptionsSchema.parse({
      kind: "openai-chat-vendor",
      enableThinking: true,
    })
    if (r.kind === "openai-chat-vendor") {
      expect(r.enableThinking).toBe(true)
    }
  })

  test("ReasoningOptions: gemini variant", () => {
    const r = ReasoningOptionsSchema.parse({
      kind: "gemini",
      includeThoughts: true,
      thinkingBudget: 4096,
    })
    if (r.kind === "gemini") {
      expect(r.includeThoughts).toBe(true)
      expect(r.thinkingBudget).toBe(4096)
    }
  })

  test("ReasoningOptions: rejects generic thinkingLevel string", () => {
    const result = ReasoningOptionsSchema.safeParse({
      kind: "generic",
      thinkingLevel: "heavy",
    })
    expect(result.success).toBe(false)
  })

  test("ReasoningOptions: rejects anthropic without mode", () => {
    const result = ReasoningOptionsSchema.safeParse({ kind: "anthropic" })
    expect(result.success).toBe(false)
  })

  test("ReasoningOptions: rejects openai-responses with invalid effort", () => {
    const result = ReasoningOptionsSchema.safeParse({
      kind: "openai-responses",
      effort: "extreme",
    })
    expect(result.success).toBe(false)
  })

  test("ProviderIdentity: parses a builtin anthropic provider", () => {
    const p = ProviderIdentitySchema.parse({
      providerId: "anthropic",
      kind: "anthropic",
      displayName: "Anthropic",
      authEnv: ["ANTHROPIC_API_KEY"],
      source: "builtin",
    })

    expect(p.kind).toBe("anthropic")
    expect(p.authEnv).toEqual(["ANTHROPIC_API_KEY"])
  })

  test("ProviderIdentity: parses an env-configured openai-compatible provider", () => {
    const p = ProviderIdentitySchema.parse({
      providerId: "openai-compatible",
      kind: "openai-compatible-chat",
      displayName: "Custom Endpoint",
      baseUrl: "https://api.example.com/v1",
      authEnv: ["OPENAI_API_KEY"],
      source: "env",
    })

    expect(p.baseUrl).toBe("https://api.example.com/v1")
  })

  test("ProviderIdentity: rejects unknown kind", () => {
    const result = ProviderIdentitySchema.safeParse({
      providerId: "x",
      kind: "unknown",
      displayName: "X",
      authEnv: [],
      source: "env",
    })
    expect(result.success).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import {
  CONFIG_DIAGNOSTIC_LEVELS,
  ConfigDiagnosticLevelSchema,
  ConfigDiagnosticSchema,
  MODEL_REGISTRY_SOURCES,
  ModelCatalogEntrySchema,
  ModelRegistryLoadResultSchema,
  ModelRegistrySourceSchema,
  NormalizedProviderErrorSchema,
  PROVIDER_ERROR_CATEGORIES,
  ProviderErrorCategorySchema,
} from "./model-registry-types"

describe("Todo 3: ModelRegistryLoadResult / ConfigDiagnostic / NormalizedProviderError", () => {
  test("parses a ModelCatalogEntry with minimal fields", () => {
    const entry = ModelCatalogEntrySchema.parse({
      ref: { providerId: "openai-compatible", modelId: "gpt-5.5" },
    })

    expect(entry.ref.modelId).toBe("gpt-5.5")
  })

  test("parses a ModelCatalogEntry with all fields", () => {
    const entry = ModelCatalogEntrySchema.parse({
      ref: { providerId: "anthropic", modelId: "claude-sonnet-4-5", displayName: "Sonnet 4.5" },
      contextLimit: 200000,
      description: "Balanced model",
      deprecated: false,
    })

    expect(entry.contextLimit).toBe(200000)
    expect(entry.deprecated).toBe(false)
  })

  test("all ConfigDiagnosticLevel values covered", () => {
    expect(CONFIG_DIAGNOSTIC_LEVELS).toEqual(["info", "warning", "error"])
    for (const level of CONFIG_DIAGNOSTIC_LEVELS) {
      expect(ConfigDiagnosticLevelSchema.parse(level)).toBe(level)
    }
  })

  test("parses a ConfigDiagnostic with entryId", () => {
    const d = ConfigDiagnosticSchema.parse({
      level: "warning",
      message: "Invalid entry skipped",
      entryId: "bad-model",
    })

    expect(d.level).toBe("warning")
    expect(d.entryId).toBe("bad-model")
  })

  test("parses a ConfigDiagnostic without entryId", () => {
    const d = ConfigDiagnosticSchema.parse({
      level: "error",
      message: "Malformed JSON",
    })

    expect(d.entryId).toBeUndefined()
  })

  test("all ModelRegistrySource values covered", () => {
    expect(MODEL_REGISTRY_SOURCES).toEqual(["models-json", "built-in", "merged"])
    for (const src of MODEL_REGISTRY_SOURCES) {
      expect(ModelRegistrySourceSchema.parse(src)).toBe(src)
    }
  })

  test("parses a ModelRegistryLoadResult with 3 valid entries and 1 warning", () => {
    const result = ModelRegistryLoadResultSchema.parse({
      entries: [
        { ref: { providerId: "anthropic", modelId: "claude-sonnet-4-5" } },
        { ref: { providerId: "anthropic", modelId: "claude-haiku-3.5" } },
        { ref: { providerId: "openai-compatible", modelId: "gpt-5.5" } },
      ],
      diagnostics: [
        { level: "warning", message: "Entry 'bad-model' has no providerId", entryId: "bad-model" },
      ],
      source: "models-json",
    })

    expect(result.entries).toHaveLength(3)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.source).toBe("models-json")
  })

  test("parses a ModelRegistryLoadResult from built-in fallback (malformed JSON)", () => {
    const result = ModelRegistryLoadResultSchema.parse({
      entries: [{ ref: { providerId: "anthropic", modelId: "claude-sonnet-4-5" } }],
      diagnostics: [
        { level: "error", message: "Malformed JSON in models.json, using built-in catalog" },
      ],
      source: "built-in",
    })

    expect(result.source).toBe("built-in")
    expect(result.diagnostics[0]?.level).toBe("error")
  })

  test("all ProviderErrorCategory values covered", () => {
    expect(PROVIDER_ERROR_CATEGORIES).toEqual([
      "auth",
      "rate-limit",
      "model-not-found",
      "context-length",
      "network",
      "server-error",
      "unknown",
    ])
    for (const cat of PROVIDER_ERROR_CATEGORIES) {
      expect(ProviderErrorCategorySchema.parse(cat)).toBe(cat)
    }
  })

  test("parses a NormalizedProviderError for auth failure", () => {
    const err = NormalizedProviderErrorSchema.parse({
      category: "auth",
      userMessage: "Invalid API key",
      retryable: false,
      rawStatus: 401,
      rawType: "invalid_api_key",
      rawMessage: "Incorrect API key provided",
    })

    expect(err.category).toBe("auth")
    expect(err.retryable).toBe(false)
    expect(err.rawStatus).toBe(401)
  })

  test("parses a NormalizedProviderError for rate limit", () => {
    const err = NormalizedProviderErrorSchema.parse({
      category: "rate-limit",
      userMessage: "Rate limit exceeded. Please retry in 30s.",
      retryable: true,
      rawStatus: 429,
      rawMessage: "Rate limit reached",
    })

    expect(err.retryable).toBe(true)
  })

  test("rejects NormalizedProviderError with empty rawMessage", () => {
    const result = NormalizedProviderErrorSchema.safeParse({
      category: "unknown",
      userMessage: "Something went wrong",
      retryable: false,
      rawMessage: "",
    })

    expect(result.success).toBe(false)
  })

  test("rejects ConfigDiagnostic with empty message", () => {
    const result = ConfigDiagnosticSchema.safeParse({
      level: "info",
      message: "",
    })

    expect(result.success).toBe(false)
  })

  test("rejects ModelRegistryLoadResult with unknown source", () => {
    const result = ModelRegistryLoadResultSchema.safeParse({
      entries: [],
      diagnostics: [],
      source: "custom",
    })

    expect(result.success).toBe(false)
  })
})

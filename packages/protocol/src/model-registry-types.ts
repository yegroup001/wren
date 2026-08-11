import { z } from "zod"
import {
  EffortLevelSchema,
  ModelRefSchema,
  ReasoningMechanismSchema,
  ReasoningModeSchema,
} from "./model-contract"

// ---------------------------------------------------------------------------
// ModelCatalogEntry — one entry from models.json or built-in catalog
// ---------------------------------------------------------------------------

export const ModelCatalogEntrySchema = z.object({
  ref: ModelRefSchema,
  contextLimit: z.number().int().positive().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
  /** Provider name (key from config.providers) — identifies the actual API endpoint */
  providerName: z.string().optional(),
  /** Source key from config.sources — disambiguates same-named models. */
  sourceName: z.string().min(1).optional(),
  /** API base URL from the provider config */
  baseUrl: z.string().optional(),
  /** Supported effort levels (empty if the model doesn't use effort levels) */
  efforts: z.array(EffortLevelSchema).readonly().optional(),
  /** How this model controls thinking, derived from provider kind + model config */
  reasoningMechanism: ReasoningMechanismSchema.optional(),
  /** Default effort level for this model */
  defaultEffort: EffortLevelSchema.optional(),
  /** Gemini thinking budget */
  thinkingBudget: z.number().int().nonnegative().optional(),
  /** Anthropic reasoning mode */
  reasoningMode: ReasoningModeSchema.optional(),
  /** Anthropic budget tokens (when reasoningMode is "budget") */
  budgetTokens: z.number().int().positive().optional(),
  /** OpenAI-compatible thinking toggle (e.g., DeepSeek, MiMo) */
  enableThinking: z.boolean().optional(),
})

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

// ---------------------------------------------------------------------------
// ConfigDiagnostic — visible diagnostics replacing silent fallback
// ---------------------------------------------------------------------------

export const CONFIG_DIAGNOSTIC_LEVELS = ["info", "warning", "error"] as const
export type ConfigDiagnosticLevel = (typeof CONFIG_DIAGNOSTIC_LEVELS)[number]
export const ConfigDiagnosticLevelSchema = z.enum(CONFIG_DIAGNOSTIC_LEVELS)

export const ConfigDiagnosticSchema = z.object({
  level: ConfigDiagnosticLevelSchema,
  message: z.string().min(1),
  entryId: z.string().optional(),
})

export type ConfigDiagnostic = z.infer<typeof ConfigDiagnosticSchema>

// ---------------------------------------------------------------------------
// ModelRegistryLoadResult — output of the model registry parser
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY_SOURCES = ["models-json", "built-in", "merged"] as const
export type ModelRegistrySource = (typeof MODEL_REGISTRY_SOURCES)[number]
export const ModelRegistrySourceSchema = z.enum(MODEL_REGISTRY_SOURCES)

export const ModelRegistryLoadResultSchema = z.object({
  entries: z.array(ModelCatalogEntrySchema).readonly(),
  diagnostics: z.array(ConfigDiagnosticSchema).readonly(),
  source: ModelRegistrySourceSchema,
})

export type ModelRegistryLoadResult = z.infer<typeof ModelRegistryLoadResultSchema>

// ---------------------------------------------------------------------------
// NormalizedProviderError — typed provider error for UI diagnostics
// ---------------------------------------------------------------------------

export const PROVIDER_ERROR_CATEGORIES = [
  "auth",
  "rate-limit",
  "model-not-found",
  "context-length",
  "network",
  "server-error",
  "unknown",
] as const
export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number]
export const ProviderErrorCategorySchema = z.enum(PROVIDER_ERROR_CATEGORIES)

export const NormalizedProviderErrorSchema = z.object({
  category: ProviderErrorCategorySchema,
  userMessage: z.string().min(1),
  retryable: z.boolean(),
  rawStatus: z.number().int().optional(),
  rawType: z.string().optional(),
  rawMessage: z.string().min(1),
})

export type NormalizedProviderError = z.infer<typeof NormalizedProviderErrorSchema>

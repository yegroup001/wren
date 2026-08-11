import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ConfigDiagnostic, ModelCatalogEntry, ModelRegistryLoadResult } from "@wren/protocol"
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ProviderKind,
  ProviderKindReasoningCapabilities,
} from "@wren/protocol"
import { z } from "zod"
import { getWrenConfigHome } from "./config-home"
import { type WrenConfig, WrenConfigSchema, type WrenModel } from "./wren-config"

// ---------------------------------------------------------------------------
// Built-in model catalog — the canonical fallback when no config file exists
// ---------------------------------------------------------------------------

export const BUILT_IN_MODEL_ENTRIES: readonly ModelCatalogEntry[] = [
  {
    ref: { providerId: "openai-compatible-chat", modelId: "gpt-4o", displayName: "GPT-4o" },
    contextLimit: 128000,
    reasoningMechanism: "none",
  },
  {
    ref: {
      providerId: "openai-compatible-chat",
      modelId: "gpt-4o-mini",
      displayName: "GPT-4o mini",
    },
    contextLimit: 128000,
    reasoningMechanism: "none",
  },
  {
    ref: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
    },
    contextLimit: 200000,
    reasoningMechanism: "reasoning-mode",
    reasoningMode: "adaptive",
  },
  {
    ref: { providerId: "anthropic", modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    contextLimit: 200000,
    reasoningMechanism: "reasoning-mode",
    reasoningMode: "adaptive",
  },
  {
    ref: { providerId: "anthropic", modelId: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
    contextLimit: 200000,
    reasoningMechanism: "reasoning-mode",
    reasoningMode: "adaptive",
  },
  {
    ref: { providerId: "openai-compatible-chat", modelId: "glm-5.2", displayName: "GLM 5.2" },
    contextLimit: 1048576,
    reasoningMechanism: "effort-levels",
    efforts: EFFORT_LEVELS,
  },
  {
    ref: {
      providerId: "openai-compatible-chat",
      modelId: "glm-5.2-fast",
      displayName: "GLM 5.2 Fast",
    },
    contextLimit: 128000,
    reasoningMechanism: "none",
  },
]

/** Read config from workspace + `~/.wren/config.json` and return typed load result with diagnostics. */
export function loadModelRegistry(
  cwd?: string,
  opts?: { readonly skipGlobalConfig?: boolean },
): ModelRegistryLoadResult {
  if (!opts?.skipGlobalConfig) {
    const { config, diagnostics: configDiags } = loadWrenConfigSync(cwd)
    if (config !== null) {
      const result = configToCatalog(config)
      return { ...result, diagnostics: [...configDiags, ...result.diagnostics] }
    }
    if (configDiags.length > 0) {
      return {
        entries: BUILT_IN_MODEL_ENTRIES,
        diagnostics: [
          ...configDiags,
          { level: "warning", message: "Using built-in catalog due to config errors" },
        ],
        source: "built-in",
      }
    }
  }

  return {
    entries: BUILT_IN_MODEL_ENTRIES,
    diagnostics: [{ level: "info", message: "No config found; using built-in catalog" }],
    source: "built-in",
  }
}

function loadWrenConfigSync(cwd?: string): {
  config: WrenConfig | null
  diagnostics: ConfigDiagnostic[]
} {
  const diagnostics: ConfigDiagnostic[] = []
  const paths: string[] = []
  if (cwd !== undefined) {
    paths.push(join(cwd, ".wren", "config.json"))
  }
  paths.push(join(getWrenConfigHome(), "config.json"))

  let baseConfig: Record<string, unknown> | null = null
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const text = readFileSync(p, "utf8")
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (baseConfig === null) {
        baseConfig = parsed
      } else {
        baseConfig = deepMergeConfig(baseConfig, parsed) as Record<string, unknown>
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        diagnostics.push({
          level: "error",
          message: `Failed to read config ${p}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  if (baseConfig === null) {
    return { config: null, diagnostics }
  }

  const result = WrenConfigSchema.safeParse(baseConfig)
  if (result.success) return { config: result.data, diagnostics }
  diagnostics.push({
    level: "error",
    message: `Config validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
  })
  return { config: null, diagnostics }
}

function configToCatalog(config: WrenConfig): ModelRegistryLoadResult {
  const entries: ModelCatalogEntry[] = []
  for (const [sourceName, source] of Object.entries(config.sources)) {
    for (const [modelId, model] of Object.entries(source.models)) {
      entries.push({
        ref: {
          providerId: source.type,
          modelId,
          displayName: model.displayName,
        },
        contextLimit: model.contextWindow,
        providerName: sourceName,
        sourceName,
        baseUrl: source.baseUrl,
        ...buildThinkingMetadata(source.type as ProviderKind, model),
      })
    }
  }
  if (entries.length === 0) {
    return {
      entries: BUILT_IN_MODEL_ENTRIES,
      diagnostics: [
        {
          level: "warning",
          message: "config.json contained no valid models; using built-in catalog",
        },
      ],
      source: "built-in",
    }
  }
  return {
    entries: Object.freeze(entries),
    diagnostics: [],
    source: "merged",
  }
}

/**
 * Deep merge two config objects. Nested records (models, providers, etc.)
 * are merged key-by-key rather than replaced. Arrays and scalars are
 * replaced by the source value.
 */
function deepMergeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeConfig(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Derive catalog thinking metadata from the model config and provider kind.
 * If the model has supportsThinking=false, returns empty metadata.
 * If the model uses enableThinking (openai-compatible-chat toggle), the mechanism
 * is "thinking-toggle" rather than the provider kind default "effort-levels".
 */
function buildThinkingMetadata(
  kind: ProviderKind,
  model: WrenModel,
): Partial<
  Pick<
    ModelCatalogEntry,
    | "efforts"
    | "reasoningMechanism"
    | "defaultEffort"
    | "thinkingBudget"
    | "reasoningMode"
    | "budgetTokens"
    | "enableThinking"
  >
> {
  if (!model.supportsThinking) return { reasoningMechanism: "none" }

  const caps = ProviderKindReasoningCapabilities[kind]

  // openai-compatible-chat with enableThinking uses thinking-toggle mechanism
  if (model.enableThinking !== undefined) {
    return {
      reasoningMechanism: "thinking-toggle",
      enableThinking: model.enableThinking,
    }
  }

  switch (caps.mechanism) {
    case "effort-levels": {
      const efforts: readonly EffortLevel[] = model.efforts ?? EFFORT_LEVELS
      return {
        reasoningMechanism: "effort-levels",
        efforts,
        defaultEffort: model.effort,
      }
    }
    case "thinking-budget":
      return {
        reasoningMechanism: "thinking-budget",
        thinkingBudget: model.thinkingBudget,
      }
    case "reasoning-mode":
      return {
        reasoningMechanism: "reasoning-mode",
        reasoningMode: model.reasoningMode,
        budgetTokens: model.budgetTokens,
      }
    case "thinking-toggle":
      return {
        reasoningMechanism: "thinking-toggle",
        enableThinking: model.enableThinking,
      }
    default:
      return {}
  }
}

// ---------------------------------------------------------------------------
// GROK_MODEL_MAP validation — Zod schema for JSON-parsed user override
// ---------------------------------------------------------------------------

const GrokModelMapSchema = z.record(z.string(), z.string())

/** Parse and validate GROK_MODEL_MAP env var. Returns null on invalid/missing. */
export function parseGrokModelMap(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const result = GrokModelMapSchema.safeParse(parsed)
    if (result.success) return result.data
    return null
  } catch {
    return null
  }
}

import {
  loadWrenConfig,
  patchWrenUserConfig,
  type WrenConfig,
  type WrenModel,
  type WrenProvider,
} from "@wren/config-node"
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ProviderKind,
  ProviderKindReasoningCapabilities,
  type SelectedModelReference,
} from "@wren/protocol"
import { clearOpenAIClientCache } from "../../services/api/openai/client.js"

let _config: WrenConfig | null = null
let _loaded = false

export type ResolvedModelConfig = {
  readonly reference: SelectedModelReference
  readonly source: WrenProvider
  readonly model: WrenModel
}

/**
 * Resolve a configured model without changing process-wide environment state.
 * Request paths should use this result when provider settings must remain
 * isolated between concurrent sessions.
 */
export function resolveModelConfig(
  selection: SelectedModelReference | string,
): ResolvedModelConfig {
  const config = getConfig()
  const reference = resolveModelReference(config, selection)
  const source = config.sources[reference.source]
  if (source === undefined) {
    throw new Error(`source "${reference.source}" not found`)
  }
  const model = source.models[reference.model]
  if (model === undefined) {
    throw new Error(`model "${reference.model}" not found in source "${reference.source}"`)
  }
  return { reference, source, model }
}

/**
 * Populate process.env from the Wren config so the vendored engine's
 * OpenAI/Anthropic clients (which read env vars directly) pick up the
 * correct credentials, endpoints, and model parameters.
 *
 * ~/.wren/config.json is the sole config source.
 *
 * Config fields → env var bridge:
 * - provider.apiKey/baseUrl  → OPENAI_API_KEY / OPENAI_BASE_URL / etc.
 * - model.maxOutputTokens    → WREN_MAX_OUTPUT_TOKENS
 * - model.contextWindow      → WREN_MAX_CONTEXT_TOKENS
 * - model.supportsThinking   → OPENAI_ENABLE_THINKING
 *
 * We do NOT set OPENAI_MODEL: resolveOpenAIModel() treats it as a blanket
 * override for every model name, which would break per-session model
 * switching. The model name flows from config.defaultModel → getMainLoopModel()
 * → engine → resolveOpenAIModel() pass-through.
 */
function applyProviderEnv(provider: WrenProvider): void {
  switch (provider.type) {
    case "openai-official":
    case "openai-compatible-chat":
      if (
        process.env.OPENAI_API_KEY !== provider.apiKey ||
        process.env.OPENAI_BASE_URL !== provider.baseUrl
      ) {
        clearOpenAIClientCache()
      }
      if (provider.apiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = provider.apiKey
      if (provider.baseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = provider.baseUrl
      process.env.WREN_USE_OPENAI = "1"
      delete process.env.OPENAI_MODEL
      delete process.env.OPENAI_SMALL_FAST_MODEL
      break
    case "anthropic":
      if (provider.apiKey) process.env.ANTHROPIC_API_KEY = provider.apiKey
      if (provider.baseUrl) process.env.ANTHROPIC_BASE_URL = provider.baseUrl
      delete process.env.WREN_USE_OPENAI
      break
    case "gemini":
      if (provider.apiKey) process.env.GEMINI_API_KEY = provider.apiKey
      break
    case "grok":
      if (provider.apiKey) process.env.XAI_API_KEY = provider.apiKey
      break
    default: {
      const providerType: never = provider.type
      throw new Error(`Unsupported provider type: ${providerType}`)
    }
  }
}

function applyModelLimits(modelConfig: WrenModel): void {
  if (modelConfig.maxOutputTokens !== undefined) {
    process.env.WREN_MAX_OUTPUT_TOKENS = String(modelConfig.maxOutputTokens)
  } else {
    delete process.env.WREN_MAX_OUTPUT_TOKENS
  }
  delete process.env.OPENAI_MAX_TOKENS

  process.env.WREN_MAX_CONTEXT_TOKENS = String(modelConfig.contextWindow)
  // For openai-compatible-chat models with explicit enableThinking config,
  // use that value instead of the general supportsThinking gate.
  if (modelConfig.enableThinking !== undefined) {
    process.env.OPENAI_ENABLE_THINKING = modelConfig.enableThinking ? "1" : "0"
  } else {
    process.env.OPENAI_ENABLE_THINKING = modelConfig.supportsThinking ? "1" : "0"
  }
  delete process.env.WREN_DISABLE_THINKING
}

export function resolveModelReference(
  config: WrenConfig,
  selection: SelectedModelReference | string,
): SelectedModelReference {
  if (typeof selection !== "string") return selection

  const slashIdx = selection.indexOf("/")
  if (slashIdx <= 0) {
    throw new Error(`model reference "${selection}" must use <source>/<model>`)
  }

  const sourceName = selection.slice(0, slashIdx)
  const model = selection.slice(slashIdx + 1)
  const source = config.sources[sourceName]
  if (source === undefined) {
    throw new Error(`source "${sourceName}" not found`)
  }
  if (source.models[model] === undefined) {
    throw new Error(`model "${model}" not found in source "${sourceName}"`)
  }
  return { source: sourceName, model }
}

export function formatModelReference(reference: {
  readonly source: string
  readonly model: string
}): string {
  return `${reference.source}/${reference.model}`
}

function applyModelConfig(config: WrenConfig, selection: SelectedModelReference | string): void {
  const reference = resolveModelReference(config, selection)
  const source = config.sources[reference.source]
  if (source === undefined) {
    throw new Error(`source "${reference.source}" not found`)
  }
  const modelConfig = source.models[reference.model]
  if (modelConfig === undefined) {
    throw new Error(`model "${reference.model}" not found in source "${reference.source}"`)
  }
  applyProviderEnv(source)
  applyModelLimits(modelConfig)
}

export function applyModelConfigToEnv(selection: SelectedModelReference | string): void {
  applyModelConfig(getConfig(), selection)
}

/**
 * Get the fallback model chain for a given model ID.
 * Returns an ordered list of model IDs to try if the primary model fails.
 * The primary model itself is NOT included in the returned list.
 */
export function getModelFallbacks(modelId: string): string[] {
  if (!_loaded || _config === null) return []
  const reference = resolveModelReference(_config, modelId)
  return _config.sources[reference.source]?.models[reference.model]?.fallback ?? []
}

export async function initConfig(explicitPath?: string, cwd?: string): Promise<void> {
  if (_loaded) return
  const result = await loadWrenConfig(explicitPath, cwd)
  if (result.success) {
    _config = result.config
    applyModelConfig(_config, _config.defaultModel)
  } else {
    throw new Error(result.error)
  }
  _loaded = true
}

export function getConfig(): WrenConfig {
  if (!_loaded) {
    throw new Error("Config not loaded. Call initConfig() first.")
  }
  return (
    _config ??
    (() => {
      throw new Error("Config is null")
    })()
  )
}

export function getWrenConfigSafe(): WrenConfig | undefined {
  if (!_loaded || _config === null) return undefined
  return _config
}

/**
 * Look up a model's configured default effort level directly from the loaded Wren
 * config — no env vars, no model-name matching. Returns undefined when config
 * isn't loaded or the model has no effort set.
 */
export function getModelEffort(model: string): string | undefined {
  if (!_loaded || _config === null) return undefined
  const reference = resolveModelReference(_config, model)
  return _config.sources[reference.source]?.models[reference.model]?.effort
}

/**
 * Get the supported effort levels for a model. If the model config specifies
 * `efforts` explicitly, return that. Otherwise derive from the provider kind's
 * reasoning capability and supportsThinking. Returns an empty array for models
 * that don't use effort levels (e.g., Gemini, Anthropic).
 */
export function getModelEfforts(model: string): readonly EffortLevel[] {
  if (!_loaded || _config === null) return []
  const reference = resolveModelReference(_config, model)
  const source = _config.sources[reference.source]
  const modelConfig = source?.models[reference.model]
  if (modelConfig === undefined) return []
  if (!modelConfig.supportsThinking) return []

  // If enableThinking is set, the model uses thinking-toggle, not effort levels
  if (modelConfig.enableThinking !== undefined) return []

  if (source === undefined) return []
  const caps = ProviderKindReasoningCapabilities[source.type as ProviderKind]
  if (caps.mechanism !== "effort-levels") return []

  return modelConfig.efforts ?? EFFORT_LEVELS
}

/**
 * Get the provider kind for a model. Returns undefined if config is not loaded
 * or the model/provider is not found.
 */
export function getModelProviderKind(model: string): ProviderKind | undefined {
  if (!_loaded || _config === null) return undefined
  const reference = resolveModelReference(_config, model)
  const source = _config.sources[reference.source]
  const modelConfig = source?.models[reference.model]
  if (modelConfig === undefined) return undefined
  return source?.type as ProviderKind | undefined
}

/**
 * Check if a model uses effort levels as its thinking-control mechanism.
 */
export function modelUsesEffortLevels(model: string): boolean {
  if (!_loaded || _config === null) return false
  const reference = resolveModelReference(_config, model)
  const modelConfig = _config.sources[reference.source]?.models[reference.model]
  if (modelConfig === undefined) return false
  if (!modelConfig.supportsThinking) return false
  // openai-compatible-chat with enableThinking uses thinking-toggle instead
  if (modelConfig.enableThinking !== undefined) return false
  const kind = getModelProviderKind(model)
  if (kind === undefined) return false
  const caps = ProviderKindReasoningCapabilities[kind]
  return caps.mechanism === "effort-levels"
}

export function setConfigForTests(config: WrenConfig | null): void {
  _config = config
  _loaded = config !== null
}

/**
 * Persist a top-level patch to ~/.wren/config.json and refresh the
 * in-memory config. Returns false (leaving the file untouched) when no
 * user config exists or the merged result fails validation — callers then
 * fall back to the legacy ~/.wren/.wren.json store.
 */
export async function patchWrenConfig(patch: Record<string, unknown>): Promise<boolean> {
  if (!_loaded || _config === null) return false
  const result = await patchWrenUserConfig(patch)
  if (!result.success) return false
  _config = result.config
  return true
}

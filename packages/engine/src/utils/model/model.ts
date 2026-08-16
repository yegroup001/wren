// biome-ignore-all assist/source/organizeImports: import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them.
 */
import { getMainLoopModelOverride } from "../../bootstrap/state.js"
import { has1mContext, modelSupports1M } from "../context.js"
import { getModelStrings, resolveOverriddenModel } from "./modelStrings.js"
import type { PermissionMode } from "../permissions/PermissionMode.js"
import { getAPIProvider } from "./providers.js"
import { type ModelAlias, isModelAlias } from "./aliases.js"
import { capitalize } from "../stringUtils.js"
import { formatModelReference, getConfig } from "./configBridge.js"

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

/**
 * Strip the source prefix from a source-qualified model ID.
 * "anthropic/claude-opus-4-7" → "claude-opus-4-7"
 * "claude-opus-4-7" → "claude-opus-4-7" (no change)
 */
function bareModelName(model: ModelName): ModelName {
  const slashIdx = model.indexOf("/")
  return slashIdx > 0 ? model.slice(slashIdx + 1) : model
}

/**
 * Returns the defaultModel. Used by side-query call sites that haven't been
 * explicitly classified in taskModels.
 */
export function getSmallFastModel(): ModelName {
  return formatModelReference(getConfig().defaultModel)
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  const bare = bareModelName(model)
  return (
    bare === getModelStrings().opus40 ||
    bare === getModelStrings().opus41 ||
    bare === getModelStrings().opus45 ||
    bare === getModelStrings().opus46 ||
    bare === getModelStrings().opus47
  )
}

/**
 * Helper to get the model from /model (including via /config) or the --model flag.
 * The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    return modelOverride
  }
  return undefined
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. Built-in default from config
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return formatModelReference(getConfig().defaultModel)
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
export function getDefaultOpusModel(): ModelName {
  return formatModelReference(getConfig().defaultModel)
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
export function getDefaultSonnetModel(): ModelName {
  return formatModelReference(getConfig().defaultModel)
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
// NOTE: legacy name. Now just returns defaultModel.
export function getDefaultHaikuModel(): ModelName {
  return formatModelReference(getConfig().defaultModel)
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === "opusplan" &&
    permissionMode === "plan" &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting from config.
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  return formatModelReference(getConfig().defaultModel)
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return formatModelReference(getConfig().defaultModel)
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes("claude-opus-4-7")) {
    return "claude-opus-4-7"
  }
  if (name.includes("claude-opus-4-6")) {
    return "claude-opus-4-6"
  }
  if (name.includes("claude-opus-4-5")) {
    return "claude-opus-4-5"
  }
  if (name.includes("claude-opus-4-1")) {
    return "claude-opus-4-1"
  }
  if (name.includes("claude-opus-4")) {
    return "claude-opus-4"
  }
  if (name.includes("claude-sonnet-4-6")) {
    return "claude-sonnet-4-6"
  }
  if (name.includes("claude-sonnet-4-5")) {
    return "claude-sonnet-4-5"
  }
  if (name.includes("claude-sonnet-4")) {
    return "claude-sonnet-4"
  }
  if (name.includes("claude-haiku-4-5")) {
    return "claude-haiku-4-5"
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes("claude-3-7-sonnet")) {
    return "claude-3-7-sonnet"
  }
  if (name.includes("claude-3-5-sonnet")) {
    return "claude-3-5-sonnet"
  }
  if (name.includes("claude-3-5-haiku")) {
    return "claude-3-5-haiku"
  }
  if (name.includes("claude-3-opus")) {
    return "claude-3-opus"
  }
  if (name.includes("claude-3-sonnet")) {
    return "claude-3-sonnet"
  }
  if (name.includes("claude-3-haiku")) {
    return "claude-3-haiku"
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Strip source prefix so canonical name matching works with source-qualified IDs.
  const bare = bareModelName(fullModelName)
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(bare))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getClaudeAiUserDefaultModelDescription(_fastMode = false): string {
  return "Default model"
}

export function renderDefaultModelSetting(_setting: ModelName | ModelAlias): string {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

export function getOpusPricingSuffix(_fastMode: boolean): string {
  return ""
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === "opusplan") {
    return "Opus Plan"
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  const bare = bareModelName(model)
  switch (bare) {
    case getModelStrings().opus47:
      return "Opus 4.7"
    case getModelStrings().opus47 + "[1m]":
      return "Opus 4.7 (1M context)"
    case getModelStrings().opus46:
      return "Opus 4.6"
    case getModelStrings().opus46 + "[1m]":
      return "Opus 4.6 (1M context)"
    case getModelStrings().opus45:
      return "Opus 4.5"
    case getModelStrings().opus41:
      return "Opus 4.1"
    case getModelStrings().opus40:
      return "Opus 4"
    case getModelStrings().sonnet46 + "[1m]":
      return "Sonnet 4.6 (1M context)"
    case getModelStrings().sonnet46:
      return "Sonnet 4.6"
    case getModelStrings().sonnet45 + "[1m]":
      return "Sonnet 4.5 (1M context)"
    case getModelStrings().sonnet45:
      return "Sonnet 4.5"
    case getModelStrings().sonnet40:
      return "Sonnet 4"
    case getModelStrings().sonnet40 + "[1m]":
      return "Sonnet 4 (1M context)"
    case getModelStrings().sonnet37:
      return "Sonnet 3.7"
    case getModelStrings().sonnet35:
      return "Sonnet 3.5"
    case getModelStrings().haiku45:
      return "Haiku 4.5"
    case getModelStrings().haiku35:
      return "Haiku 3.5"
    default:
      return null
  }
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  return bareModelName(model)
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Wren {ModelName}" for publicly known models, or "Wren ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Wren {ModelName}" for public models, or "Wren ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Wren ${publicName}`
  }
  return `Wren (${bareModelName(model)})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag ? normalizedModel.replace(/\[1m]$/i, "").trim() : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case "opusplan":
        return getDefaultSonnetModel() + (has1mTag ? "[1m]" : "")
      case "sonnet":
        return getDefaultSonnetModel() + (has1mTag ? "[1m]" : "")
      case "haiku":
        return getDefaultHaikuModel() + (has1mTag ? "[1m]" : "")
      case "opus":
        return getDefaultOpusModel() + (has1mTag ? "[1m]" : "")
      case "best":
        return getBestModel()
      default:
    }
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, "").trim() + "[1m]"
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(skillModel: string, currentModel: string): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + "[1m]"
  }
  return skillModel
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === "foundry") {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  const has1m = modelId.toLowerCase().includes("[1m]")
  const canonical = getCanonicalName(modelId)

  if (canonical.includes("claude-opus-4-7")) {
    return has1m ? "Opus 4.7 (with 1M context)" : "Opus 4.7"
  }
  if (canonical.includes("claude-opus-4-6")) {
    return has1m ? "Opus 4.6 (with 1M context)" : "Opus 4.6"
  }
  if (canonical.includes("claude-opus-4-5")) {
    return "Opus 4.5"
  }
  if (canonical.includes("claude-opus-4-1")) {
    return "Opus 4.1"
  }
  if (canonical.includes("claude-opus-4")) {
    return "Opus 4"
  }
  if (canonical.includes("claude-sonnet-4-6")) {
    return has1m ? "Sonnet 4.6 (with 1M context)" : "Sonnet 4.6"
  }
  if (canonical.includes("claude-sonnet-4-5")) {
    return has1m ? "Sonnet 4.5 (with 1M context)" : "Sonnet 4.5"
  }
  if (canonical.includes("claude-sonnet-4")) {
    return has1m ? "Sonnet 4 (with 1M context)" : "Sonnet 4"
  }
  if (canonical.includes("claude-3-7-sonnet")) {
    return "Claude 3.7 Sonnet"
  }
  if (canonical.includes("claude-3-5-sonnet")) {
    return "Claude 3.5 Sonnet"
  }
  if (canonical.includes("claude-haiku-4-5")) {
    return "Haiku 4.5"
  }
  if (canonical.includes("claude-3-5-haiku")) {
    return "Claude 3.5 Haiku"
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, "")
}

// biome-ignore-all assist/source/organizeImports: import markers must not be reordered
import { getInitialSettings } from "./settings/settings.js"
import { getLocalFeatureValue } from "src/utils/featureGates.js"
import { getAPIProviderForModel } from "./model/providers.js"
import { get3PModelCapabilityOverride } from "./model/modelSupportOverrides.js"
import { isEnvTruthy } from "./envUtils.js"
import type { EffortLevel } from "src/entrypoints/sdk/runtimeTypes.js"
import { isChatGPTAuthMode, isChatGPTCodexReasoningModel } from "./model/chatgptModels.js"

export type { EffortLevel }

// NOTE: 'ultracode' is NOT an effort level. It is a session-scoped multi-agent
// orchestration opt-in injected by the harness (claude.ai/client) as a
// system-reminder, orthogonal to the effort parameter. EffortLevel / EffortValue
// must never include 'ultracode'; /effort only accepts the levels below.
export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.WREN_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, "effort")
  if (supported3P !== undefined) {
    return supported3P
  }
  if (
    getAPIProviderForModel(model) === "openai" &&
    isChatGPTAuthMode() &&
    isChatGPTCodexReasoningModel(model)
  ) {
    return true
  }
  // Supported by a subset of the configured models
  if (
    m.includes("opus-4-7") ||
    m.includes("opus-4-6") ||
    m.includes("sonnet-4-6") ||
    m.includes("deepseek-v4-pro")
  ) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes("haiku") || m.includes("sonnet") || m.includes("opus")) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return getAPIProviderForModel(model) === "firstParty"
}

// Effort max/xhigh restrictions removed — all models that support effort
// can now use these levels. API errors are the user's responsibility.
export function modelSupportsMaxEffort(_model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(_model, "max_effort")
  if (supported3P !== undefined) {
    return supported3P
  }
  return true
}

export function modelSupportsXhighEffort(_model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(_model, "xhigh_effort")
  if (supported3P !== undefined) {
    return supported3P
  }
  return true
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(value: EffortValue | undefined): EffortLevel | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.WREN_EFFORT_LEVEL
  return envOverride?.toLowerCase() === "unset" || envOverride?.toLowerCase() === "auto"
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env WREN_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved = envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // OpenAI Responses uses xhigh as its highest public reasoning effort.
  // Keep /effort max usable as a familiar alias in ChatGPT subscription mode.
  if (
    resolved === "max" &&
    getAPIProviderForModel(model) === "openai" &&
    isChatGPTAuthMode() &&
    modelSupportsXhighEffort(model)
  ) {
    return "xhigh"
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? "high"
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(model: string, effortValue: EffortValue | undefined): string {
  if (effortValue === undefined) return ""
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ""
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === "string") {
    // Runtime guard: value may come from remote config (feature gate) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : "high"
  }
  return "high"
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case "low":
      return "Quick, straightforward implementation with minimal overhead"
    case "medium":
      return "Balanced approach with standard implementation and testing"
    case "high":
      return "Comprehensive implementation with extensive testing and documentation"
    case "xhigh":
      return "Extended reasoning beyond high, short of max"
    case "max":
      return "Maximum capability with deepest reasoning"
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (typeof value === "string") {
    return getEffortLevelDescription(value)
  }
  return "Balanced approach with standard implementation and testing"
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: "We recommend medium effort for Opus",
  dialogDescription:
    "Effort determines how long Wren thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.",
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getLocalFeatureValue("wren_grey_step2", OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT)
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(model: string): EffortValue | undefined {
  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  if (
    getAPIProviderForModel(model) === "openai" &&
    isChatGPTAuthMode() &&
    isChatGPTCodexReasoningModel(model)
  ) {
    return "medium"
  }

  // Default effort on Opus 4.6/4.7 to high when the wren_grey_step2 config is enabled.
  if (model.toLowerCase().includes("opus-4-7") || model.toLowerCase().includes("opus-4-6")) {
    if (getOpusDefaultEffortConfig().enabled) {
      return "high"
    }
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}

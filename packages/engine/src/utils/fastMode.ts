import { getLocalFeatureValue } from "src/utils/featureGates.js"
import {
  getIsNonInteractiveSession,
  getKairosActive,
  preferThirdPartyAuthentication,
} from "../bootstrap/state.js"

import { getClaudeAIOAuthTokens } from "./auth.js"
import { isInBundledMode } from "./bundledMode.js"
import { logForDebugging } from "./debug.js"
import { isEnvTruthy } from "./envUtils.js"
import {
  getDefaultMainLoopModelSetting,
  type ModelSetting,
  parseUserSpecifiedModel,
} from "./model/model.js"
import { getAPIProvider } from "./model/providers.js"
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from "./settings/settings.js"
import { createSignal } from "./signal.js"

export function isFastModeEnabled(): boolean {
  return !isEnvTruthy(process.env.WREN_DISABLE_FAST_MODE)
}

export function isFastModeAvailable(): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  return getFastModeUnavailableReason() === null
}

type AuthType = "oauth" | "api-key"

function getDisabledReasonMessage(
  disabledReason: FastModeDisabledReason,
  authType: AuthType,
): string {
  switch (disabledReason) {
    case "free":
      return authType === "oauth"
        ? "Fast mode requires a paid subscription"
        : "Fast mode unavailable during evaluation. Please purchase credits."
    case "preference":
      return "Fast mode has been disabled by your organization"
    case "extra_usage_disabled":
      // Only OAuth users can have extra_usage_disabled; console users don't have this concept
      return "Fast mode requires extra usage billing · /extra-usage to enable"
    case "network_error":
      return "Fast mode unavailable due to network connectivity issues"
    case "unknown":
      return "Fast mode is currently unavailable"
  }
}

export function getFastModeUnavailableReason(): string | null {
  if (!isFastModeEnabled()) {
    return "Fast mode is not available"
  }

  const statigReason = getLocalFeatureValue("wren_penguins_off", null)
  // feature gate reason has priority over other reasons.
  if (statigReason !== null) {
    logForDebugging(`Fast mode unavailable: ${statigReason}`)
    return statigReason
  }

  // Previously, fast mode required the native binary (bun build). This is no
  // longer necessary, but we keep this option behind a flag just in case.
  if (!isInBundledMode() && getLocalFeatureValue("wren_marble_sandcastle", false)) {
    return "Fast mode requires the native binary · Install from: https://github.com/yegroup001/wren"
  }

  // Not available in the SDK unless explicitly opted in via --settings.
  // Assistant daemon mode is exempt — it's first-party orchestration, and
  // kairosActive is set before this check runs (main.tsx:~1626 vs ~3249).
  if (getIsNonInteractiveSession() && preferThirdPartyAuthentication() && !getKairosActive()) {
    const flagFastMode = getSettingsForSource("flagSettings")?.fastMode
    if (!flagFastMode) {
      const reason = "Fast mode is not available in the Agent SDK"
      logForDebugging(`Fast mode unavailable: ${reason}`)
      return reason
    }
  }

  // Only available for 1P (not Bedrock/Vertex/Foundry)
  if (getAPIProvider() !== "firstParty") {
    const reason = "Fast mode is not available on Bedrock, Vertex, or Foundry"
    logForDebugging(`Fast mode unavailable: ${reason}`)
    return reason
  }

  if (orgStatus.status === "disabled") {
    if (orgStatus.reason === "network_error" || orgStatus.reason === "unknown") {
      // The org check can fail behind corporate proxies that block the
      // endpoint. We add WREN_SKIP_FAST_MODE_NETWORK_ERRORS=1 to
      // bypass this check in the CC binary. This is OK since we have
      // another check in the API to error out when disabled by org.
      if (isEnvTruthy(process.env.WREN_SKIP_FAST_MODE_NETWORK_ERRORS)) {
        return null
      }
    }
    const authType: AuthType = getClaudeAIOAuthTokens() !== null ? "oauth" : "api-key"
    const reason = getDisabledReasonMessage(orgStatus.reason, authType)
    logForDebugging(`Fast mode unavailable: ${reason}`)
    return reason
  }

  return null
}

// @[MODEL LAUNCH]: Update supported Fast Mode models.
export const FAST_MODE_MODEL_DISPLAY = "Opus 4.7"

export function getFastModeModel(): string {
  return "opus"
}

export function getInitialFastModeSetting(model: ModelSetting): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  if (!isFastModeAvailable()) {
    return false
  }
  if (!isFastModeSupportedByModel(model)) {
    return false
  }
  const settings = getInitialSettings()
  // If per-session opt-in is required, fast mode starts off each session
  if (settings.fastModePerSessionOptIn) {
    return false
  }
  return settings.fastMode === true
}

export function isFastModeSupportedByModel(modelSetting: ModelSetting): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  const model = modelSetting ?? getDefaultMainLoopModelSetting()
  const parsedModel = parseUserSpecifiedModel(model)
  return (
    parsedModel.toLowerCase().includes("opus-4-7") || parsedModel.toLowerCase().includes("opus-4-6")
  )
}

// --- Fast mode runtime state ---
// Separate from user preference (settings.fastMode). This tracks the actual
// operational state: whether we're actively sending fast speed or in cooldown
// after a rate limit.

export type FastModeRuntimeState =
  | { status: "active" }
  | { status: "cooldown"; resetAt: number; reason: CooldownReason }

let runtimeState: FastModeRuntimeState = { status: "active" }
let hasLoggedCooldownExpiry = false

// --- Cooldown event listeners ---
export type CooldownReason = "rate_limit" | "overloaded"

const cooldownTriggered = createSignal<[resetAt: number, reason: CooldownReason]>()
const cooldownExpired = createSignal()
export const onCooldownTriggered = cooldownTriggered.subscribe
export const onCooldownExpired = cooldownExpired.subscribe

export function getFastModeRuntimeState(): FastModeRuntimeState {
  if (runtimeState.status === "cooldown" && Date.now() >= runtimeState.resetAt) {
    if (isFastModeEnabled() && !hasLoggedCooldownExpiry) {
      logForDebugging("Fast mode cooldown expired, re-enabling fast mode")
      hasLoggedCooldownExpiry = true
      cooldownExpired.emit()
    }
    runtimeState = { status: "active" }
  }
  return runtimeState
}

export function triggerFastModeCooldown(resetTimestamp: number, reason: CooldownReason): void {
  if (!isFastModeEnabled()) {
    return
  }
  runtimeState = { status: "cooldown", resetAt: resetTimestamp, reason }
  hasLoggedCooldownExpiry = false
  const cooldownDurationMs = resetTimestamp - Date.now()
  logForDebugging(
    `Fast mode cooldown triggered (${reason}), duration ${Math.round(cooldownDurationMs / 1000)}s`,
  )
  cooldownTriggered.emit(resetTimestamp, reason)
}

export function clearFastModeCooldown(): void {
  runtimeState = { status: "active" }
}

/**
 * Called when the API rejects a fast mode request (e.g., 400 "Fast mode is
 * not enabled for your organization"). Permanently disables fast mode using
 * the same flow as when the prefetch discovers the org has it disabled.
 */
export function handleFastModeRejectedByAPI(): void {
  if (orgStatus.status === "disabled") {
    return
  }
  orgStatus = { status: "disabled", reason: "preference" }
  updateSettingsForSource("userSettings", { fastMode: undefined })
  orgFastModeChange.emit(false)
}

// --- Overage rejection listeners ---
// Fired when a 429 indicates fast mode was rejected because extra usage
// (overage billing) is not available. Distinct from org-level disabling.
const overageRejection = createSignal<[message: string]>()
export const onFastModeOverageRejection = overageRejection.subscribe

function getOverageDisabledMessage(reason: string | null): string {
  switch (reason) {
    case "out_of_credits":
      return "Fast mode disabled · extra usage credits exhausted"
    case "org_level_disabled":
    case "org_service_level_disabled":
      return "Fast mode disabled · extra usage disabled by your organization"
    case "org_level_disabled_until":
      return "Fast mode disabled · extra usage spending cap reached"
    case "member_level_disabled":
      return "Fast mode disabled · extra usage disabled for your account"
    case "seat_tier_level_disabled":
    case "seat_tier_zero_credit_limit":
    case "member_zero_credit_limit":
      return "Fast mode disabled · extra usage not available for your plan"
    case "overage_not_provisioned":
    case "no_limits_configured":
      return "Fast mode requires extra usage billing · /extra-usage to enable"
    default:
      return "Fast mode disabled · extra usage not available"
  }
}

function isOutOfCreditsReason(reason: string | null): boolean {
  return reason === "org_level_disabled_until" || reason === "out_of_credits"
}

/**
 * Called when a 429 indicates fast mode was rejected because extra usage
 * is not available. Permanently disables fast mode (unless the user has
 * ran out of credits) and notifies with a reason-specific message.
 */
export function handleFastModeOverageRejection(reason: string | null): void {
  const message = getOverageDisabledMessage(reason)
  logForDebugging(`Fast mode overage rejection: ${reason ?? "unknown"} — ${message}`)
  // Disable fast mode permanently unless the user has ran out of credits
  if (!isOutOfCreditsReason(reason)) {
    updateSettingsForSource("userSettings", { fastMode: undefined })
  }
  overageRejection.emit(message)
}

export function isFastModeCooldown(): boolean {
  return getFastModeRuntimeState().status === "cooldown"
}

export function getFastModeState(
  model: ModelSetting,
  fastModeUserEnabled: boolean | undefined,
): "off" | "cooldown" | "on" {
  const enabled =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !!fastModeUserEnabled &&
    isFastModeSupportedByModel(model)
  if (enabled && isFastModeCooldown()) {
    return "cooldown"
  }
  if (enabled) {
    return "on"
  }
  return "off"
}

// Disabled reason returned by the API. The API is the canonical source for why
// fast mode is disabled (free account, admin preference, extra usage not enabled).
export type FastModeDisabledReason =
  | "free"
  | "preference"
  | "extra_usage_disabled"
  | "network_error"
  | "unknown"

// In-memory cache of the fast mode status.
// Distinct from the user's fastMode app state — this represents
// whether the org *allows* fast mode and why it may be disabled.
// Decoupled from subscription status: defaults to enabled, and is only
// set to "disabled" when the API rejects a fast mode request.
type FastModeOrgStatus =
  | { status: "pending" }
  | { status: "enabled" }
  | { status: "disabled"; reason: FastModeDisabledReason }

let orgStatus: FastModeOrgStatus = { status: "pending" }

// Listeners notified when org-level fast mode status changes
const orgFastModeChange = createSignal<[orgEnabled: boolean]>()
export const onOrgFastModeChanged = orgFastModeChange.subscribe

/**
 * Resolve orgStatus from the persisted cache without making any API calls.
 * Fast mode is now decoupled from subscription status — default to enabled.
 */
export function resolveFastModeStatusFromCache(): void {
  if (!isFastModeEnabled()) {
    return
  }
  if (orgStatus.status !== "pending") {
    return
  }
  orgStatus = { status: "enabled" }
}

/**
 * Fast mode status is no longer fetched from a server.
 * Fast mode availability is determined by local settings and API feedback
 * (handleFastModeRejectedByAPI / handleFastModeOverageRejection).
 */
export async function prefetchFastModeStatus(): Promise<void> {
  // No-op: fast mode status is resolved locally via resolveFastModeStatusFromCache().
  // The server-side org status check has been removed.
}

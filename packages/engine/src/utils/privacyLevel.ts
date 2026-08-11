/**
 * Privacy level controls how much nonessential network traffic and telemetry
 * Wren generates.
 *
 * Levels are ordered by restrictiveness:
 *   default < no-telemetry < essential-traffic
 *
 * - default:            Everything enabled.
 * - no-telemetry:       Analytics/telemetry disabled (Datadog, 1P events, feedback survey).
 * - essential-traffic:  ALL nonessential network traffic disabled
 *                       (telemetry + auto-updates, grove, release notes, model capabilities, etc.).
 *
 * Wren is no-telemetry by default: the upstream telemetry/analytics machinery
 * (1P event logging, Datadog, feature-flag polling, API preconnect) ships in
 * the vendored engine, so the default must be restrictive rather than
 * permissive. `WREN_ENABLE_TELEMETRY=1` restores the upstream default level
 * for deployments that self-host those sinks.
 *
 * The resolved level is the most restrictive signal from:
 *   WREN_DISABLE_NONESSENTIAL_TRAFFIC  →  essential-traffic
 *   WREN_DISABLE_TELEMETRY             →  no-telemetry
 *   WREN_ENABLE_TELEMETRY              →  default (opt-in)
 */

type PrivacyLevel = "default" | "no-telemetry" | "essential-traffic"

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC) {
    return "essential-traffic"
  }
  if (process.env.WREN_DISABLE_TELEMETRY) {
    return "no-telemetry"
  }
  if (process.env.WREN_ENABLE_TELEMETRY === "1") {
    return "default"
  }
  return "no-telemetry"
}

/**
 * True when all nonessential network traffic should be suppressed.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === "essential-traffic"
}

/**
 * True when telemetry/analytics should be suppressed.
 * True at both `no-telemetry` and `essential-traffic` levels.
 */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== "default"
}

/**
 * Returns the env var name responsible for the current essential-traffic restriction,
 * or null if unrestricted. Used for user-facing "unset X to re-enable" messages.
 */
export function getEssentialTrafficOnlyReason(): string | null {
  if (process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC) {
    return "WREN_DISABLE_NONESSENTIAL_TRAFFIC"
  }
  return null
}

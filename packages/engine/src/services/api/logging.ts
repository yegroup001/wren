import {
  addToTotalDurationState,
  getTeleportedSessionInfo,
  markFirstTeleportMessageLogged,
  setLastApiCompletionTimestamp,
} from "src/bootstrap/state.js"
import { logForDebugging } from "src/utils/debug.js"
import { logError } from "src/utils/log.js"
import type { NonNullableUsage } from "../../entrypoints/sdk/sdkUtilityTypes.js"
import { EMPTY_USAGE } from "./emptyUsage.js"
import { extractConnectionErrorDetails } from "./errorUtils.js"

export type { NonNullableUsage }
export { EMPTY_USAGE }

// Strategy used for global prompt caching
export type GlobalCacheStrategy = "tool_based" | "system_prompt" | "none"

export function logAPIError({
  error,
  headers,
  clientRequestId,
}: {
  error: unknown
  headers?: globalThis.Headers
  /** Client-generated ID sent as x-client-request-id header (survives timeouts) */
  clientRequestId?: string
}): void {
  // Log detailed connection error info to debug logs (visible via --debug)
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? " (SSL error)" : ""
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: "error" },
    )
  }

  if (clientRequestId) {
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: "error" },
    )
  }

  logError(error as Error)

  // Log first error for teleported sessions (reliability tracking)
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    markFirstTeleportMessageLogged()
  }
}

export function logAPISuccessAndDuration({
  start,
  startIncludingRetries,
}: {
  start: number
  startIncludingRetries: number
}): void {
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  addToTotalDurationState(durationMsIncludingRetries, durationMs)
  setLastApiCompletionTimestamp(Date.now())

  // Log first successful message for teleported sessions (reliability tracking)
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    markFirstTeleportMessageLogged()
  }
}

/**
 * Session ID tag translation helpers for the CCR v2 compat layer.
 *
 * Re-tag a `cse_*` session ID to `session_*` for use with the v1 compat API.
 * Worker endpoints (/v1/code/sessions/{id}/worker/*) want `cse_*`; that's
 * what the work poll delivers. Client-facing compat endpoints
 * (/v1/sessions/{id}, /v1/sessions/{id}/archive, /v1/sessions/{id}/events)
 * want `session_*` — compat/convert.go:27 validates TagSession. Same UUID,
 * different costume. No-op for IDs that aren't `cse_*`.
 */

/**
 * Re-tag a `cse_*` session ID to `session_*` for use with the v1 compat API.
 * No-op for IDs that aren't `cse_*`.
 */
export function toCompatSessionId(id: string): string {
  if (!id.startsWith("cse_")) return id
  return "session_" + id.slice("cse_".length)
}

/**
 * Re-tag a `session_*` session ID to `cse_*` for infrastructure-layer calls.
 * No-op for IDs that aren't `session_*`.
 */
export function toInfraSessionId(id: string): string {
  if (!id.startsWith("session_")) return id
  return "cse_" + id.slice("session_".length)
}

/**
 * Error classification for plugin/marketplace fetches that hit the network.
 *
 * Added for inc-5046 (GitHub complained about claude-plugins-official load).
 * classifyFetchError buckets raw errors into stable, bounded categories so
 * callers can surface a readable failure reason without leaking raw error
 * messages.
 */

/**
 * Classify an error into a stable bucket for the error_kind field. Keeps
 * cardinality bounded — raw error messages would explode dashboard grouping.
 *
 * Handles both axios Error objects (Node.js error codes like ENOTFOUND) and
 * git stderr strings (human phrases like "Could not resolve host"). DNS
 * checked BEFORE timeout because gitClone's error enhancement at
 * marketplaceManager.ts:~950 rewrites DNS failures to include the word
 * "timeout" — ordering the other way would misclassify git DNS as timeout.
 */
export function classifyFetchError(error: unknown): string {
  const msg = String((error as { message?: unknown })?.message ?? error)
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|Could not resolve host|Connection refused/i.test(msg)) {
    return "dns_or_refused"
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(msg)) return "timeout"
  if (/ECONNRESET|socket hang up|Connection reset by peer|remote end hung up/i.test(msg)) {
    return "conn_reset"
  }
  if (/403|401|authentication|permission denied/i.test(msg)) return "auth"
  if (/404|not found|repository not found/i.test(msg)) return "not_found"
  if (/certificate|SSL|TLS|unable to get local issuer/i.test(msg)) return "tls"
  // Schema validation throws "Invalid response format" (install_counts) —
  // distinguish from true unknowns so the dashboard can
  // see "server sent garbage" separately.
  if (/Invalid response format|Invalid marketplace schema/i.test(msg)) {
    return "invalid_schema"
  }
  return "other"
}

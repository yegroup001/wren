import { createHash } from "node:crypto"

/**
 * Produces a stable, opaque cache-routing key without exposing Wren's source,
 * model, session, or agent identifiers to the provider.
 */
export function createOpenAIPromptCacheKey(params: {
  source: string
  model: string
  conversationId: string
}): string {
  const fingerprint = createHash("sha256")
    .update(`${params.source}\u0000${params.model}\u0000${params.conversationId}`)
    .digest("hex")
    .slice(0, 32)
  return `wren-${fingerprint}`
}

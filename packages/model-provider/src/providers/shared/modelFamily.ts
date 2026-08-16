export type ModelFamily = "haiku" | "sonnet" | "opus"

/** Strip the trailing "[1m]" context marker Anthropic adds to 1M-context model IDs. */
export function strip1mSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, "")
}

/**
 * Classify an Anthropic-tier-style model name into its family.
 *
 * Compatibility shim for Anthropic-named inputs ("claude-sonnet-…",
 * "claude-opus-…", "claude-haiku-…"). In a provider-neutral deployment the
 * model name is used literally — this helper only fires when the name itself
 * contains an Anthropic tier word, so tier-scoped env overrides act only on
 * those legacy names.
 */
export function getModelFamily(model: string): ModelFamily | null {
  if (/haiku/i.test(model)) return "haiku"
  if (/opus/i.test(model)) return "opus"
  if (/sonnet/i.test(model)) return "sonnet"
  return null
}

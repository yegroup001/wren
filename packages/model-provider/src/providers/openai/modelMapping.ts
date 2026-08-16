import { getModelFamily, strip1mSuffix } from "../shared/modelFamily.js"

/**
 * Default mapping for Anthropic-named inputs to OpenAI model names.
 * Used when no provider-specific env overrides are set.
 */
const DEFAULT_MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-20250514": "gpt-4o",
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
  "claude-opus-4-20250514": "o3",
  "claude-opus-4-1-20250805": "o3",
  "claude-opus-4-5-20251101": "o3",
  "claude-opus-4-6": "o3",
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-3-5-haiku-20241022": "gpt-4o-mini",
  "claude-3-7-sonnet-20250219": "gpt-4o",
  "claude-3-5-sonnet-20241022": "gpt-4o",
}

/**
 * Resolve the OpenAI model name for a given (provider-neutral) model name.
 *
 * Priority:
 * 1. OPENAI_MODEL env var (override all)
 * 2. OPENAI_DEFAULT_{TIER}_MODEL env var (e.g. OPENAI_DEFAULT_SONNET_MODEL),
 *    BUT ONLY when the input name literally contains an Anthropic tier word
 *    (haiku|sonnet|opus) — a backward-compatibility shim for Anthropic-named
 *    inputs, NOT a general tier inference.
 * 3. DEFAULT_MODEL_MAP lookup (for known Anthropic IDs)
 * 4. Pass through the original model name
 *
 * The `ANTHROPIC_DEFAULT_{TIER}_MODEL` cross-provider fallback has been
 * removed deliberately; configure OpenAI through `OPENAI_*` env vars or the
 * Wren config's `sources.<name>.type = "openai-official"` block.
 */
export function resolveOpenAIModel(modelName: string): string {
  if (process.env["OPENAI_MODEL"]) {
    return process.env["OPENAI_MODEL"]
  }

  const cleanModel = strip1mSuffix(modelName)

  const family = getModelFamily(cleanModel)
  if (family) {
    const openaiEnvVar = `OPENAI_DEFAULT_${family.toUpperCase()}_MODEL`
    const openaiOverride = process.env[openaiEnvVar]
    if (openaiOverride) return openaiOverride
  }

  return DEFAULT_MODEL_MAP[cleanModel] ?? cleanModel
}

import { getModelFamily, strip1mSuffix } from "../shared/modelFamily.js"

/**
 * Resolve the Gemini model name for a given (provider-neutral) model name.
 *
 * The name is used literally. Tier-scoped env overrides act ONLY when the
 * name itself carries an Anthropic tier word (haiku|sonnet|opus) — a
 * backward-compatibility shim for Anthropic-named inputs, not a general tier
 * inference.
 *
 * Priority:
 * 1. GEMINI_MODEL env var (override everything)
 * 2. GEMINI_DEFAULT_{TIER}_MODEL env var (only on tier-named inputs)
 * 3. Pass through the original name — requires one of the above when the
 *    input is tier-named, else the configured Gemini model ID must be given
 *    through the Wren config's `sources.<name>` block or GEMINI_MODEL.
 */
export function resolveGeminiModel(modelName: string): string {
  if (process.env["GEMINI_MODEL"]) {
    return process.env["GEMINI_MODEL"]
  }

  const cleanModel = strip1mSuffix(modelName)
  const family = getModelFamily(cleanModel)

  if (!family) {
    return cleanModel
  }

  const geminiEnvVar = `GEMINI_DEFAULT_${family.toUpperCase()}_MODEL`
  const geminiModel = process.env[geminiEnvVar]
  if (geminiModel) {
    return geminiModel
  }

  throw new Error(
    `Gemini provider requires GEMINI_MODEL or ${geminiEnvVar} to be configured.`,
  )
}

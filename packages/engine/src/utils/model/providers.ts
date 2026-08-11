import { getConfig, resolveModelReference } from "./configBridge.js"

export type APIProvider =
  | "firstParty"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "openai"
  | "gemini"
  | "grok"

/**
 * Resolve the APIProvider for a specific model ID.
 * Falls back to the default model's provider if the model is not found.
 */
export function getAPIProviderForModel(modelId: string | undefined): APIProvider {
  const config = getConfig()
  const reference = resolveModelReference(config, modelId ?? config.defaultModel)
  const source = config.sources[reference.source]
  if (source === undefined) return "firstParty"
  switch (source.type) {
    case "anthropic":
      return "firstParty"
    case "openai-official":
    case "openai-compatible-chat":
      return "openai"
    case "gemini":
      return "gemini"
    case "grok":
      return "grok"
    default:
      return "firstParty"
  }
}

export function getAPIProvider(): APIProvider {
  return getAPIProviderForModel(undefined)
}

export function isFirstPartyAnthropicBaseUrl(): boolean {
  const config = getConfig()
  const reference = resolveModelReference(config, config.defaultModel)
  return config.sources[reference.source]?.type === "anthropic"
}

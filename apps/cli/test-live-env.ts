export const LIVE_OPENAI_ENV_SKIP_REASON =
  "Set OPENAI_API_KEY and OPENAI_BASE_URL to run live OpenAI-compatible CLI tests"

export type LiveOpenAiEnv = Record<string, string>

export function getLiveOpenAiEnv(): LiveOpenAiEnv | null {
  const apiKey = process.env["OPENAI_API_KEY"]
  const baseUrl = process.env["OPENAI_BASE_URL"]

  if (
    apiKey === undefined ||
    apiKey.length === 0 ||
    baseUrl === undefined ||
    baseUrl.length === 0
  ) {
    return null
  }

  return {
    WREN_USE_OPENAI: "1",
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_MODEL: "gpt-5.5",
  }
}

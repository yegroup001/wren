/**
 * Pure utility functions for building OpenAI request bodies and detecting
 * thinking mode. Extracted from index.ts so tests can import them without
 * triggering heavy module side-effects (OpenAI client, stream adapter, etc.).
 */
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions/completions.mjs"
import { isEnvDefinedFalsy, isEnvTruthy } from "../../../utils/envUtils.js"

/**
 * Detect whether thinking mode should be enabled for this model.
 *
 * Enabled when:
 * 1. OPENAI_ENABLE_THINKING=1 is set (explicit enable), OR
 * 2. Model name contains "deepseek" or "mimo" (auto-detect, case-insensitive)
 *
 * Disabled when:
 * - OPENAI_ENABLE_THINKING=0/false/no/off is explicitly set (overrides model detection)
 *
 * @param model - The resolved OpenAI model name
 */
export function isOpenAIThinkingEnabled(model: string, configured?: boolean): boolean {
  if (configured !== undefined) return configured
  // Explicit disable takes priority (overrides model auto-detect)
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // Explicit enable
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // Auto-detect from model name (DeepSeek and MiMo models support thinking mode).
  // Grok is intentionally excluded — Grok reasoning models reason automatically
  // and do NOT require thinking/enable_thinking request body parameters.
  const modelLower = model.toLowerCase()
  return modelLower.includes("deepseek") || modelLower.includes("mimo")
}

/**
 * Resolve max output tokens for the OpenAI-compatible path.
 *
 * Override priority:
 * 1. maxOutputTokensOverride (programmatic, from query pipeline)
 * 2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
 *    with small context windows, e.g. RTX 3060 12GB running 65536-token models)
 * 3. configuredMaxOutputTokens (source/model configuration)
 * 4. WREN_MAX_OUTPUT_TOKENS env var (legacy fallback when enabled)
 * 5. upperLimit default (64000)
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
  configuredMaxOutputTokens?: number,
  useLegacyEnvironment = true,
): number {
  return (
    maxOutputTokensOverride ??
    (process.env.OPENAI_MAX_TOKENS
      ? parseInt(process.env.OPENAI_MAX_TOKENS, 10) || undefined
      : undefined) ??
    configuredMaxOutputTokens ??
    (useLegacyEnvironment && process.env.WREN_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.WREN_MAX_OUTPUT_TOKENS, 10) || undefined
      : undefined) ??
    upperLimit
  )
}

/**
 * Build the request body for OpenAI chat.completions.create().
 * Extracted for testability — the thinking mode params are injected here.
 *
 * Three thinking-mode formats are sent simultaneously; each endpoint uses the
 * format it recognizes and ignores the others:
 * - Official DeepSeek API:    `thinking: { type: 'enabled' }`
 * - Self-hosted DeepSeek:     `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo (Xiaomi):            `chat_template_kwargs: { enable_thinking: true }`
 * OpenAI SDK passes unknown keys through to the HTTP body.
 */
export function buildOpenAIRequestBody(params: {
  model: string
  messages: ChatCompletionCreateParamsStreaming["messages"]
  tools: NonNullable<ChatCompletionCreateParamsStreaming["tools"]>
  toolChoice?: ChatCompletionCreateParamsStreaming["tool_choice"]
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  reasoningEffort?: string
  promptCacheKey?: string
}): ChatCompletionCreateParamsStreaming & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  reasoning_effort?: string
} {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    temperatureOverride,
    reasoningEffort,
    promptCacheKey,
  } = params
  return {
    model,
    messages,
    max_tokens: maxTokens,
    ...(tools.length > 0 && {
      tools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    // Enable chain-of-thought output for DeepSeek and MiMo models.
    // When active, temperature/top_p/presence_penalty/frequency_penalty are ignored.
    ...(enableThinking && {
      // Official DeepSeek API format
      thinking: { type: "enabled" },
      // Self-hosted DeepSeek-V3.2 format
      enable_thinking: true,
      // Both DeepSeek self-hosted and MiMo formats in chat_template_kwargs
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    // Only send temperature when thinking mode is off (DeepSeek ignores it anyway,
    // but other providers may respect it)
    ...(!enableThinking &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  } as ChatCompletionCreateParamsStreaming & {
    thinking?: { type: string }
    enable_thinking?: boolean
    chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
    reasoning_effort?: string
  }
}

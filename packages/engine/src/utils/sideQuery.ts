import type Anthropic from "@anthropic-ai/sdk"
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages.js"
import {
  anthropicMessagesToOpenAI,
  anthropicToolChoiceToGemini,
  anthropicToolChoiceToOpenAI,
  anthropicToolsToGemini,
  anthropicToolsToOpenAI,
  resolveGeminiModel,
  resolveGrokModel,
  resolveOpenAIModel,
} from "@wren/model-provider"
import { setLastApiCompletionTimestamp } from "../bootstrap/state.js"
import { STRUCTURED_OUTPUTS_BETA_HEADER } from "../constants/betas.js"
import type { QuerySource } from "../constants/querySource.js"
import { getCLISyspromptPrefix } from "../constants/system.js"
import { getAPIMetadata } from "../services/api/claude.js"
import { getAnthropicClient } from "../services/api/client.js"
import { getGrokClient } from "../services/api/grok/client.js"
import { getOpenAIClient } from "../services/api/openai/client.js"
import { getModelBetas, modelSupportsStructuredOutputs } from "./betas.js"
import { logForDebugging } from "./debug.js"
import { normalizeModelStringForAPI } from "./model/model.js"
import { getAPIProvider } from "./model/providers.js"
import type { SystemPrompt } from "./systemPromptType.js"

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat
type BetaThinkingConfigParam = Anthropic.Beta.Messages.BetaThinkingConfigParam

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlockParam block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: MessageParam[]
  /** Optional tools (supports both standard Tool[] and BetaToolUnion[] for custom tool types) */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries (default: 2) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in wren_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
  /** When true, API failures are treated as expected for optional/best-effort queries. */
  optional?: boolean
}

/**
 * Extract system prompt text from the `system` option.
 */
function extractSystemText(system?: string | TextBlockParam[]): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system
    .filter((b): b is { type: "text"; text: string } => "text" in b && !!b.text)
    .map((b) => b.text)
    .join("\n\n")
}

/**
 * Convert Anthropic MessageParam[] to a list of {role, content} objects
 * suitable for OpenAI-compatible chat.completions APIs.
 */
function messageParamsToOpenAIRoleContent(
  messages: MessageParam[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const result: Array<{ role: "user" | "assistant"; content: string }> = []
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n")
          : ""
    if (text) {
      result.push({ role: m.role as "user" | "assistant", content: text })
    }
  }
  return result
}

/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Use this instead of direct client.beta.messages.create() calls to ensure
 * proper OAuth token validation with fingerprint attribution headers.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips [1m] suffix for API)
 * - Third-party provider routing (OpenAI, Grok, Gemini)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  const provider = getAPIProvider()
  if (provider === "openai" || provider === "grok") {
    return sideQueryViaOpenAICompatible(opts)
  }
  if (provider === "gemini") {
    return sideQueryViaGemini(opts)
  }

  const client = await getAnthropicClient({
    maxRetries,
    model,
    source: "side_query",
  })
  const betas = [...getModelBetas(model)]
  // Add structured-outputs beta if using output_format and provider supports it
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Build system as array to keep system prompt in its own block
  const systemBlocks: TextBlockParam[] = [
    // Skip CLI system prompt prefix for internal classifiers that provide their own prompt
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: "text" as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    ...(Array.isArray(system) ? system : system ? [{ type: "text" as const, text: system }] : []),
  ].filter((block): block is TextBlockParam => block !== null)

  let thinkingConfig: BetaThinkingConfigParam | undefined
  if (thinking === false) {
    thinkingConfig = { type: "disabled" }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: "enabled",
      budget_tokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const normalizedModel = normalizeModelStringForAPI(model)

  const response = await client.beta.messages.create(
    {
      model: normalizedModel,
      max_tokens,
      system: systemBlocks,
      messages,
      ...(tools && { tools }),
      ...(tool_choice && { tool_choice }),
      ...(output_format && { output_config: { format: output_format } }),
      ...(temperature !== undefined && { temperature }),
      ...(stop_sequences && { stop_sequences }),
      ...(thinkingConfig && { thinking: thinkingConfig }),
      ...(betas.length > 0 && { betas }),
      metadata: getAPIMetadata(),
    },
    { signal },
  )

  const now = Date.now()
  setLastApiCompletionTimestamp(now)

  return response
}

/**
 * OpenAI-compatible side query for OpenAI and Grok providers.
 * Both use the OpenAI SDK with different base URLs.
 *
 * Converts Anthropic-format params to OpenAI Chat Completions, sends a
 * non-streaming request, and wraps the response back into a BetaMessage
 * shape so callers remain provider-agnostic.
 *
 * Supports tools and tool_choice for structured output (e.g. yoloClassifier,
 * permissionExplainer).
 */
async function sideQueryViaOpenAICompatible(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    max_tokens = 1024,
    temperature,
    signal,
  } = opts

  const provider = getAPIProvider()
  const normalizedModel = normalizeModelStringForAPI(model)

  // Resolve model name and client per provider
  let openaiModel: string
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  let client: import("openai").default
  if (provider === "grok") {
    openaiModel = resolveGrokModel(normalizedModel)
    client = getGrokClient({ maxRetries: opts.maxRetries ?? 2 })
  } else {
    openaiModel = resolveOpenAIModel(normalizedModel)
    client = getOpenAIClient({ maxRetries: opts.maxRetries ?? 2 })
  }

  // Build system prompt text
  const systemText = extractSystemText(system)

  // Build OpenAI messages: system first, then user/assistant
  const openaiMessages: Array<{
    role: "system" | "user" | "assistant"
    content: string
  }> = []
  if (systemText) {
    openaiMessages.push({ role: "system", content: systemText })
  }
  openaiMessages.push(...messageParamsToOpenAIRoleContent(messages))

  // Convert tools and tool_choice if provided
  const openaiTools =
    tools && tools.length > 0 ? anthropicToolsToOpenAI(tools as BetaToolUnion[]) : undefined
  const openaiToolChoice = tool_choice ? anthropicToolChoiceToOpenAI(tool_choice) : undefined

  Date.now();

  const requestParams: Record<string, unknown> = {
    model: openaiModel,
    messages: openaiMessages,
    max_tokens,
  }
  if (temperature !== undefined) requestParams.temperature = temperature
  if (openaiTools && openaiTools.length > 0) {
    requestParams.tools = openaiTools
    if (openaiToolChoice) requestParams.tool_choice = openaiToolChoice
  }

  const response = await client.chat.completions.create(
    requestParams as unknown as import("openai/resources/chat/completions/completions.mjs").ChatCompletionCreateParamsNonStreaming,
    { signal },
  )

  const choice = response.choices[0]
  const message = choice?.message

  // Build content blocks for BetaMessage
  const contentBlocks: Array<
    { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }
  > = []

  if (message?.content) {
    contentBlocks.push({ type: "text", text: message.content })
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      // ChatCompletionMessageToolCall is a union — only function-type has .function
      if (tc.type === "function" && "function" in tc) {
        const fn = (tc as { function: { name: string; arguments: string } }).function
        contentBlocks.push({
          type: "tool_use",
          id: tc.id ?? `toolu_${Date.now()}`,
          name: fn.name,
          input: JSON.parse(fn.arguments || "{}"),
        })
      }
    }
  }

  setLastApiCompletionTimestamp(Date.now())

  const stopReason =
    choice?.finish_reason === "tool_calls"
      ? "tool_use"
      : choice?.finish_reason === "length"
        ? "max_tokens"
        : "end_turn"

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: contentBlocks as BetaMessage["content"],
    model: openaiModel,
    stop_reason: stopReason as BetaMessage["stop_reason"],
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  } as BetaMessage
}

/**
 * Gemini side query. Converts Anthropic-format params to Gemini
 * generateContent format, sends a non-streaming request via fetch,
 * and wraps the response back into a BetaMessage shape.
 */
async function sideQueryViaGemini(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    max_tokens = 1024,
    temperature,
    signal,
  } = opts

  const normalizedModel = normalizeModelStringForAPI(model)
  const geminiModel = resolveGeminiModel(normalizedModel)

  // Build Gemini contents from Anthropic MessageParam[]
  const contents: Array<{
    role: "user" | "model"
    parts: Array<{ text: string }>
  }> = []
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n")
          : ""
    if (text) {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      })
    }
  }

  // Build system instruction
  const systemText = extractSystemText(system)
  const systemInstruction = systemText ? { parts: [{ text: systemText }] } : undefined

  // Convert tools and tool_choice
  const geminiTools =
    tools && tools.length > 0 ? anthropicToolsToGemini(tools as BetaToolUnion[]) : undefined
  const geminiToolConfig = tool_choice ? anthropicToolChoiceToGemini(tool_choice) : undefined

  const baseUrl = (
    process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "")
  const modelPath = geminiModel.startsWith("models/") ? geminiModel : `models/${geminiModel}`
  const url = `${baseUrl}/${modelPath}:generateContent`

  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction && { systemInstruction }),
    ...(geminiTools && geminiTools.length > 0 && { tools: geminiTools }),
    ...(geminiToolConfig && {
      toolConfig: { functionCallingConfig: geminiToolConfig },
    }),
    ...(temperature !== undefined && {
      generationConfig: { temperature },
    }),
    ...(max_tokens !== undefined && {
      generationConfig: {
        ...(temperature !== undefined && { temperature }),
        maxOutputTokens: max_tokens,
      },
    }),
  }

  // Merge generationConfig if both temperature and max_tokens are set
  if (temperature !== undefined && max_tokens !== undefined) {
    body.generationConfig = { temperature, maxOutputTokens: max_tokens }
  }

  Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY || "",
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(
      `Gemini API request failed (${res.status} ${res.statusText}): ${errorBody || "empty response body"}`,
    )
  }

  const geminiResponse = (await res.json()) as {
    candidates?: Array<{
      content?: {
        role?: string
        parts?: Array<{
          text?: string
          functionCall?: { name?: string; args?: Record<string, unknown> }
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
    id?: string
  }

  // Build content blocks from Gemini response
  const contentBlocks: Array<
    { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }
  > = []

  const candidate = geminiResponse.candidates?.[0]
  const parts = candidate?.content?.parts
  if (parts) {
    for (const part of parts) {
      if (part.text) {
        contentBlocks.push({ type: "text", text: part.text })
      }
      if (part.functionCall) {
        contentBlocks.push({
          type: "tool_use",
          id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name ?? "",
          input: part.functionCall.args ?? {},
        })
      }
    }
  }

  setLastApiCompletionTimestamp(Date.now())

  const stopReason =
    candidate?.finishReason === "STOP"
      ? "end_turn"
      : candidate?.finishReason === "MAX_TOKENS"
        ? "max_tokens"
        : "end_turn"

  return {
    id: geminiResponse.id ?? `gemini_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: contentBlocks as BetaMessage["content"],
    model: geminiModel,
    stop_reason: stopReason as BetaMessage["stop_reason"],
    stop_sequence: null,
    usage: {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount ?? 0,
    },
  } as BetaMessage
}

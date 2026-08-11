import type {
  BetaMessage,
  BetaToolUnion,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs"
import {
  adaptOpenAIStreamToAnthropicWithRetry,
  anthropicMessagesToOpenAI,
  anthropicToolChoiceToOpenAI,
  anthropicToolsToOpenAI,
  resolveOpenAIModel,
} from "@wren/model-provider"
import { addToTotalSessionCost } from "../../../cost-tracker.js"
import type { Tools } from "../../../Tool.js"
import { getEmptyToolPermissionContext, toolMatchesName } from "../../../Tool.js"
import type { AgentId } from "../../../types/ids.js"
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from "../../../types/message.js"
import { toolToAPISchema } from "../../../utils/api.js"
import { logForDebugging } from "../../../utils/debug.js"
import { normalizeMessagesForAPI } from "../../../utils/messages.js"
import { resolveModelConfig } from "../../../utils/model/configBridge.js"
import { calculateUSDCost } from "../../../utils/modelCost.js"
import type { SystemPrompt } from "../../../utils/systemPromptType.js"
import { createOpenAIPromptCacheKey } from "./cacheKey.js"
import { isChatGPTAuthEnabled } from "./chatgptAuth.js"
import { getOpenAIClient } from "./client.js"
import { updateOpenAIUsage } from "./openaiShared.js"
import {
  buildOpenAIRequestBody,
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
} from "./requestBody.js"
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  type ResponsesReasoningEffort,
} from "./responsesAdapter.js"

export { buildOpenAIRequestBody, isOpenAIThinkingEnabled, resolveOpenAIMaxTokens }

import { randomUUID } from "node:crypto"
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from "src/tools/SearchExtraToolsTool/prompt.js"
import type { SDKAssistantMessageError } from "../../../entrypoints/agentSdkTypes.js"
import { getModelMaxOutputTokens } from "../../../utils/context.js"
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  normalizeContentFromAPI,
} from "../../../utils/messages.js"
import { getModelEffort, modelUsesEffortLevels } from "../../../utils/model/configBridge.js"
import {
  isDeferredToolsDeltaEnabled,
  isSearchExtraToolsEnabled,
} from "../../../utils/searchExtraTools.js"
import type { Options } from "../claude.js"

function convertToResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  if (effortValue === "low") return "low"
  if (effortValue === "medium") return "medium"
  if (effortValue === "high") return "high"
  if (effortValue === "xhigh" || effortValue === "max") return "xhigh"
  if (typeof effortValue === "number") return "high"
  return undefined
}

function getChatGPTResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  const envOverride = process.env.WREN_EFFORT_LEVEL?.toLowerCase()
  if (envOverride === "auto" || envOverride === "unset") return undefined
  return (
    convertToResponsesReasoningEffort(envOverride) ??
    convertToResponsesReasoningEffort(effortValue) ??
    "medium"
  )
}

/**
 * Mirrors the Anthropic request path's deferred-tool announcement for OpenAI.
 *
 * OpenAI-compatible endpoints cannot consume Anthropic's `defer_loading` or
 * `tool_reference` beta payloads directly, so the model needs the same textual
 * list of deferred MCP tool names that Anthropic receives before it can ask
 * SearchExtraToolsTool to load their full schemas.
 */
function prependDeferredToolListIfNeeded(
  messages: (AssistantMessage | UserMessage)[],
  tools: Tools,
  deferredToolNames: Set<string>,
  useSearchExtraTools: boolean,
): (AssistantMessage | UserMessage)[] {
  if (!useSearchExtraTools || isDeferredToolsDeltaEnabled()) return messages

  const deferredToolList = tools
    .filter((tool) => deferredToolNames.has(tool.name))
    .map(formatDeferredToolLine)
    .sort()
    .join("\n")

  if (!deferredToolList) return messages

  return [
    createUserMessage({
      content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
      isMeta: true,
    }),
    ...messages,
  ]
}

function isOpenAIConvertibleMessage(msg: Message): msg is AssistantMessage | UserMessage {
  return msg.type === "assistant" || msg.type === "user"
}

/**
 * Assemble the final AssistantMessage (and optional max_tokens error) from
 * accumulated stream state. Extracted to avoid duplication between the
 * `message_stop` handler and the post-loop safety fallback.
 */
function assembleFinalAssistantOutputs(params: {
  partialMessage: BetaMessage | null
  contentBlocks: Record<number, Record<string, unknown>>
  tools: Tools
  agentId: string | undefined
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  stopReason: string | null
  maxTokens: number
}): (AssistantMessage | SystemAPIErrorMessage)[] {
  const { partialMessage, contentBlocks, tools, agentId, usage, stopReason, maxTokens } = params
  const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []

  const allBlocks = Object.keys(contentBlocks)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => contentBlocks[Number(k)])
    .filter(Boolean)

  if (allBlocks.length > 0 && partialMessage) {
    outputs.push({
      message: {
        ...partialMessage,
        content: normalizeContentFromAPI(
          allBlocks as unknown as BetaMessage["content"],
          tools,
          agentId as AgentId | undefined,
        ),
        usage,
        stop_reason: stopReason,
        stop_sequence: null,
      } as AssistantMessage["message"],
      requestId: undefined,
      type: "assistant",
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    } as AssistantMessage)
  }

  if (stopReason === "max_tokens") {
    outputs.push(
      createAssistantAPIErrorMessage({
        content:
          `Output truncated: response exceeded the ${maxTokens} token limit. ` +
          `Set OPENAI_MAX_TOKENS or WREN_MAX_OUTPUT_TOKENS to override.`,
        apiError: "max_output_tokens",
        error: "max_output_tokens",
      }),
    )
  }

  return outputs
}

/**
 * OpenAI-compatible query path. Converts Anthropic-format messages/tools to
 * OpenAI format, calls the OpenAI-compatible endpoint, and converts the
 * SSE stream back to Anthropic BetaRawMessageStreamEvent for consumption
 * by the existing query pipeline.
 */
export async function* queryModelOpenAI(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  try {
    // 1. Resolve model name and provider configuration without mutating process.env.
    const modelConfig = resolveModelConfig(options.model)
    const selection = modelConfig.reference
    const openaiModel = resolveOpenAIModel(selection.model)

    // 2. Normalize messages using shared preprocessing
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    // 3. Check if tool search is enabled (similar to Anthropic path)
    const useSearchExtraTools = await isSearchExtraToolsEnabled(
      options.model,
      tools,
      options.getToolPermissionContext || (async () => getEmptyToolPermissionContext()),
      options.agents || [],
      options.querySource,
    )

    // 4. Build deferred tools set (similar to Anthropic path)
    const deferredToolNames = new Set<string>()
    if (useSearchExtraTools) {
      for (const t of tools) {
        if (isDeferredTool(t)) deferredToolNames.add(t.name)
      }
    }

    // 5. Filter tools (similar to Anthropic path)
    // Never include deferred tools in the API tools array — they are invoked
    // via ExecuteExtraTool which looks them up from the global tool registry
    // at runtime. Keeping the tools array stable preserves the prompt cache.
    let filteredTools = tools
    if (useSearchExtraTools && deferredToolNames.size > 0) {
      filteredTools = tools.filter((tool) => {
        // Always include non-deferred tools
        if (!deferredToolNames.has(tool.name)) return true
        // Always include SearchExtraToolsTool (so it can discover more tools)
        if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
        // All other deferred tools are excluded — use ExecuteExtraTool instead
        return false
      })
    }

    // 6. Build tool schemas with deferLoading flag
    const toolSchemas = await Promise.all(
      filteredTools.map((tool) =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
          deferLoading: useSearchExtraTools && deferredToolNames.has(tool.name),
        }),
      ),
    )

    // 7. Filter out non-standard tools (server tools like advisor)
    const standardTools = toolSchemas.filter((t): t is BetaToolUnion & { type: string } => {
      const anyT = t as unknown as Record<string, unknown>
      return anyT.type !== "advisor_20260301" && anyT.type !== "computer_20250124"
    })

    // 8. Convert messages and tools to OpenAI format
    const enableThinking = isOpenAIThinkingEnabled(
      openaiModel,
      modelConfig.model.enableThinking ?? modelConfig.model.supportsThinking,
    )
    const openAIConvertibleMessages = messagesForAPI.filter(isOpenAIConvertibleMessage)
    const messagesWithDeferredToolList = prependDeferredToolListIfNeeded(
      openAIConvertibleMessages,
      tools,
      deferredToolNames,
      useSearchExtraTools,
    )
    const openaiMessages = anthropicMessagesToOpenAI(messagesWithDeferredToolList, systemPrompt, {
      enableThinking,
    })
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)
    const sessionEffort = options.effortValue
    // Only resolve effort for models that use effort levels as their thinking mechanism.
    // Models with enableThinking (DeepSeek/MiMo toggle) or non-effort providers skip this.
    const useEffortLevels = modelUsesEffortLevels(options.model)
    const configEffort = useEffortLevels
      ? (sessionEffort ?? getModelEffort(options.model))
      : undefined
    const reasoningEffort =
      configEffort !== undefined
        ? convertToResponsesReasoningEffort(configEffort)
        : useEffortLevels
          ? getChatGPTResponsesReasoningEffort(options.effortValue)
          : undefined

    // 9. Log tool filtering details
    if (useSearchExtraTools) {
      const includedDeferredTools = filteredTools.filter((t) =>
        deferredToolNames.has(t.name),
      ).length
      logForDebugging(
        `[OpenAI] Tool search enabled: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included, total tools=${openaiTools.length}`,
      )
    } else {
      logForDebugging(`[OpenAI] Tool search disabled, total tools=${openaiTools.length}`)
    }

    // 10. Compute max_tokens — required by most OpenAI-compatible endpoints.
    //     Without this the server uses a tiny default, and when
    //     thinking is enabled the thinking phase consumes the entire budget
    //     leaving no tokens for the final response.
    //
    //     Use upperLimit (not the slot-cap default) because the Anthropic path's
    //     slot-reservation cap (CAPPED_DEFAULT_MAX_TOKENS=8k) is paired with an
    //     auto-retry at 64k in query.ts. The OpenAI path has no such retry, so
    //     using the capped 8k default would silently truncate responses in
    //     multi-turn conversations where thinking consumes most of the budget.
    //
    //     Override priority:
    //     1. options.maxOutputTokensOverride (programmatic)
    //     2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
    //        with small context windows, e.g. RTX 3060 12GB running 65536-token models)
    //     3. configured source/model maxOutputTokens
    //     4. WREN_MAX_OUTPUT_TOKENS env var for legacy callers only
    //     5. upperLimit default (64000); configured source-backed requests
    //        intentionally skip the process-wide legacy override.
    const { upperLimit } = getModelMaxOutputTokens(openaiModel)
    const maxTokens = resolveOpenAIMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
      modelConfig.model.maxOutputTokens,
      false,
    )
    const conversationId = options.agentId ?? options.sessionId
    const promptCacheKey = conversationId
      ? createOpenAIPromptCacheKey({
          source: selection.source,
          model: openaiModel,
          conversationId,
        })
      : undefined

    logForDebugging(
      `[OpenAI] Calling model=${openaiModel}, source=${selection.source}, querySource=${options.querySource}, messages=${openaiMessages.length}, tools=${openaiTools.length}, thinking=${enableThinking}, effort=${configEffort ?? "none"}, cacheKey=${promptCacheKey?.slice(0, 14) ?? "none"}`,
    )

    // 11. Call OpenAI API with streaming. ChatGPT subscription auth uses the
    // Codex Responses backend; API-key/OpenAI-compatible auth keeps the
    // existing Chat Completions adapter.
    const adaptedStream = isChatGPTAuthEnabled()
      ? adaptResponsesStreamToAnthropic(
          await createChatGPTResponsesStream({
            request: buildResponsesRequest({
              model: openaiModel,
              messages: openaiMessages,
              tools: openaiTools,
              toolChoice: openaiToolChoice,
              reasoningEffort,
              promptCacheKey,
            }),
            signal,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
          }),
          openaiModel,
        )
      : adaptOpenAIStreamToAnthropicWithRetry(
          async () =>
            await getOpenAIClient({
              // SDK auto-retries 408/409/429/5xx and connection errors with
              // exponential backoff before the stream starts. Without this a
              // transient provider error permanently kills the request — most
              // visibly subagents, which fail outright on any API hiccup.
              maxRetries: 3,
              fetchOverride: options.fetchOverride as unknown as typeof fetch,
              source: options.querySource,
              provider: {
                apiKey: modelConfig.source.apiKey,
                baseURL: modelConfig.source.baseUrl,
              },
            }).chat.completions.create(
              buildOpenAIRequestBody({
                model: openaiModel,
                messages: openaiMessages,
                tools: openaiTools,
                toolChoice: openaiToolChoice as any,
                enableThinking,
                maxTokens,
                temperatureOverride: options.temperatureOverride,
                reasoningEffort: typeof configEffort === "string" ? configEffort : undefined,
                promptCacheKey,
              }),
              { signal },
            ),
          openaiModel,
        )

    // 12. Convert OpenAI stream to Anthropic events, then process into
    //     AssistantMessage + StreamEvent (matching the Anthropic path behavior)

    // Accumulate content blocks and usage, same as the Anthropic path in claude.ts
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let stopReason: string | null = null
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    const start = Date.now()

    for await (const event of adaptedStream) {
      switch (event.type) {
        case "message_start": {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = {
              ...usage,
              ...(event.message.usage as unknown as typeof usage),
            }
          }
          break
        }
        case "content_block_start": {
          const idx = event.index
          const cb = event.content_block
          if (cb.type === "tool_use") {
            contentBlocks[idx] = { ...cb, input: "" }
          } else if (cb.type === "text") {
            contentBlocks[idx] = { ...cb, text: "" }
          } else if (cb.type === "thinking") {
            contentBlocks[idx] = { ...cb, thinking: "", signature: "" }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case "content_block_delta": {
          const idx = event.index
          const delta = event.delta
          const block = contentBlocks[idx]
          if (!block) break
          if (delta.type === "text_delta") {
            block.text = ((block.text as string | undefined) || "") + delta.text
          } else if (delta.type === "input_json_delta") {
            block.input = ((block.input as string | undefined) || "") + delta.partial_json
          } else if (delta.type === "thinking_delta") {
            block.thinking = ((block.thinking as string | undefined) || "") + delta.thinking
          } else if (delta.type === "signature_delta") {
            block.signature = delta.signature
          }
          break
        }
        case "content_block_stop": {
          // Block accumulation is complete; assembly happens at message_stop.
          break
        }
        case "message_delta": {
          const deltaUsage = event.usage
          if (deltaUsage) {
            usage = updateOpenAIUsage(
              usage,
              deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          if (event.delta.stop_reason != null) {
            stopReason = event.delta.stop_reason
          }
          break
        }
        case "message_stop": {
          // Assemble ONE AssistantMessage with ALL content blocks, matching the
          // Anthropic SDK path. Real usage (input + output tokens) is available
          // here and injected so tokenCountWithEstimation() can read it.
          if (partialMessage) {
            for (const output of assembleFinalAssistantOutputs({
              partialMessage,
              contentBlocks,
              tools,
              agentId: options.agentId,
              usage,
              stopReason,
              maxTokens,
            })) {
              if (output.type === "assistant") {
                collectedMessages.push(output)
              }
              yield output
            }
            // Reset partialMessage so the post-loop safety fallback does not
            // yield a second identical AssistantMessage.
            partialMessage = null
          }
          // Track cost and token usage
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(openaiModel, usage as unknown as BetaUsage)
            addToTotalSessionCost(costUSD, usage as unknown as BetaUsage, options.model)
          }
          break
        }
      }

      // Also yield as StreamEvent for real-time display (matching Anthropic path)
      yield {
        type: "stream_event",
        event,
        ...(event.type === "message_start" ? { ttftMs } : undefined),
      } as StreamEvent
    }

    logForDebugging(
      `[OpenAI cache] source=${selection.source}, model=${openaiModel}, querySource=${options.querySource}, promptTokens=${usage.input_tokens + usage.cache_read_input_tokens}, cachedTokens=${usage.cache_read_input_tokens}`,
    )

    // Safety: if stream ended without message_stop, assemble and yield whatever we have
    if (partialMessage) {
      for (const output of assembleFinalAssistantOutputs({
        partialMessage,
        contentBlocks,
        tools,
        agentId: options.agentId,
        usage,
        stopReason,
        maxTokens,
      })) {
        yield output
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[OpenAI] Error: ${errorMessage}`, { level: "error" })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: "api_error",
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}

import { randomUUID } from "node:crypto"
import type {
  BetaMessage,
  BetaToolUnion,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs"
import {
  adaptOpenAIStreamToAnthropic,
  anthropicMessagesToOpenAI,
  anthropicToolChoiceToOpenAI,
  anthropicToolsToOpenAI,
  resolveGrokModel,
} from "@wren/model-provider"
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions.mjs"
import { addToTotalSessionCost } from "../../../cost-tracker.js"
import type { SDKAssistantMessageError } from "../../../entrypoints/agentSdkTypes.js"
import type { Tools } from "../../../Tool.js"
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from "../../../types/message.js"
import { toolToAPISchema } from "../../../utils/api.js"
import { logForDebugging } from "../../../utils/debug.js"
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from "../../../utils/messages.js"
import { calculateUSDCost } from "../../../utils/modelCost.js"
import type { SystemPrompt } from "../../../utils/systemPromptType.js"
import type { Options } from "../claude.js"
import { updateOpenAIUsage } from "../openai/openaiShared.js"
import { getGrokClient } from "./client.js"

/**
 * Grok (xAI) query path. Grok uses an OpenAI-compatible API, so we reuse
 * the OpenAI message/tool converters and stream adapter. Only the client
 * (different base URL + API key) and model mapping are Grok-specific.
 */
export async function* queryModelGrok(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  try {
    const grokModel = resolveGrokModel(options.model)
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    const toolSchemas = await Promise.all(
      tools.map((tool) =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
      ),
    )
    const standardTools = toolSchemas.filter((t): t is BetaToolUnion & { type: string } => {
      const anyT = t as unknown as Record<string, unknown>
      return anyT.type !== "advisor_20260301" && anyT.type !== "computer_20250124"
    })

    const openaiMessages = anthropicMessagesToOpenAI(messagesForAPI, systemPrompt)
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)

    const client = getGrokClient({
      // SDK auto-retries 408/409/429/5xx and connection errors before the
      // stream starts; 0 meant any transient API error killed the request
      // (most visibly subagents, which fail outright on any API hiccup).
      maxRetries: 3,
      fetchOverride: options.fetchOverride as typeof fetch | undefined,
      source: options.querySource,
    })

    logForDebugging(
      `[Grok] Calling model=${grokModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}`,
    )

    const stream = await client.chat.completions.create(
      {
        model: grokModel,
        messages: openaiMessages,
        ...(openaiTools.length > 0 && {
          tools: openaiTools,
          ...(openaiToolChoice && { tool_choice: openaiToolChoice }),
        }),
        stream: true,
        stream_options: { include_usage: true },
        ...(options.temperatureOverride !== undefined && {
          temperature: options.temperatureOverride,
        }),
      } as ChatCompletionCreateParamsStreaming,
      {
        signal,
      },
    )

    const adaptedStream = adaptOpenAIStreamToAnthropic(
      stream as AsyncIterable<ChatCompletionChunk>,
      grokModel,
    )

    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let usage: {
      input_tokens: number
      output_tokens: number
      reasoning_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
    } = {
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    let stopReason: string | null = null
    let finalized = false
    const start = Date.now()

    const finalizeAssistant = (): AssistantMessage | undefined => {
      if (finalized || !partialMessage) return undefined
      finalized = true
      const allBlocks = Object.keys(contentBlocks)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => contentBlocks[Number(key)])
        .filter((block): block is Record<string, unknown> => block !== undefined)
      if (allBlocks.length === 0) return undefined
      const message: AssistantMessage = {
        message: {
          ...partialMessage,
          content: normalizeContentFromAPI(
            allBlocks as unknown as BetaMessage["content"],
            tools,
            options.agentId,
          ),
          usage,
          stop_reason: stopReason,
          stop_sequence: null,
        } as AssistantMessage["message"],
        requestId: undefined,
        type: "assistant",
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      }
      collectedMessages.push(message)
      return message
    }

    for await (const event of adaptedStream) {
      switch (event.type) {
        case "message_start": {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = updateOpenAIUsage(
              usage,
              event.message.usage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
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
          const message = finalizeAssistant()
          if (message !== undefined) yield message
          break
        }
      }

      yield {
        type: "stream_event",
        event,
        ...(event.type === "message_start" ? { ttftMs } : undefined),
      } as StreamEvent
    }

    const finalMessage = finalizeAssistant()
    if (finalMessage !== undefined) yield finalMessage

    if (usage.input_tokens + usage.output_tokens > 0) {
      const costUSD = calculateUSDCost(grokModel, usage as unknown as BetaUsage)
      addToTotalSessionCost(costUSD, usage as unknown as BetaUsage, options.model)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`[Grok] Error: ${errorMessage}`, { level: "error" })
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: "api_error",
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}

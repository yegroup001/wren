import { randomUUID } from "node:crypto"
import type { SDKMessage } from "@wren/engine"
import {
  type Diff,
  type Message,
  type Part,
  type PermissionDisplayType,
  parseMessageId,
  parsePartId,
  parsePermissionId,
  type SessionId,
  type SnapshotFileDiff,
  type Todo,
  type ToolStatusType,
  type Usage,
} from "@wren/protocol"
import { structuredPatch } from "diff"
import { batch } from "solid-js"
import type { TuiStoreApi } from "./store"

// ---------------------------------------------------------------------------
// Types — the SDKMessage shapes the QueryEngine actually yields.
// These are narrowed views of the loose SDKMessage type from engine.
// ---------------------------------------------------------------------------

type SystemInitMessage = {
  type: "system"
  subtype: "init"
  cwd: string
  session_id: string
  tools: string[]
  model: string
  permissionMode: string
}

type AssistantMessage = {
  type: "assistant"
  message: {
    role: "assistant"
    id: string
    model?: string
    content: ContentBlock[]
    usage?: Record<string, unknown>
  }
  uuid: string
}

type UserMessage = {
  type: "user"
  message: {
    role: "user"
    id?: string
    content: ContentBlock[] | string
  }
  uuid: string
  session_id?: string
  tool_use_result?: unknown
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  isSynthetic?: boolean
  isReplay?: boolean
}

type StreamEventMessage = {
  type: "stream_event"
  event: StreamEvent
  session_id: string
  uuid: string
}

type ResultMessage = {
  type: "result"
  subtype: string
  is_error: boolean
  duration_ms: number
  num_turns: number
  stop_reason: string | null
  session_id: string
  total_cost_usd: number
  usage: Record<string, unknown>
  modelUsage?: Record<string, unknown>
  errors?: string[]
  result?: string
}

type ApiRetryMessage = {
  type: "system"
  subtype: "api_retry"
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: string
  session_id: string
  uuid: string
}

type ToolProgressMessage = {
  type: "tool_progress"
  tool_use_id: string
  tool_name: string
  parent_tool_use_id?: string
  session_id: string
  uuid: string
  agentId?: string
  agentType?: string
  elapsed_time_seconds?: number
  task_id?: string
}

// ContentBlock — the SDK content block types we care about

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }

// StreamEvent — the SDK streaming event types

type StreamEvent =
  | { type: "message_start"; message: { id: string; model: string } }
  | { type: "message_delta"; delta: { stop_reason: string | null }; usage: Record<string, unknown> }
  | { type: "message_stop" }
  | {
      type: "content_block_start"
      index: number
      content_block: ContentBlock
    }
  | {
      type: "content_block_delta"
      index: number
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "signature_delta"; signature: string }
    }
  | { type: "content_block_stop"; index: number }

// ---------------------------------------------------------------------------
// Mapper — consumes AsyncGenerator<SDKMessage> and mutates the Solid store
// ---------------------------------------------------------------------------

type MapperClock = {
  readonly now: () => string
}

export type MessageMapperOptions = {
  readonly clock: MapperClock
  readonly sessionId: SessionId
  readonly store: TuiStoreApi
  /** Called after tool results are mapped and before the next LLM request. */
  readonly onTurnBoundary?: () => void
  /** Called when compact_boundary system message arrives — invalidates
   *  pre-compaction edit anchors and clears transient compact progress. */
  readonly onCompactBoundary?: () => void
}

export type { Usage }

type StreamingState = {
  currentMessageId: Message["id"] | null
  partIndexToId: Map<number, Part["id"]>
  toolUseIdToPartId: Map<string, Part["id"]>
  inputJsonBuffers: Map<number, string>
  typeCounters: Map<string, number>
  lastUsage: Usage | null
  terminalError: string | null
}

export type MessageStreamResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly reported: true }

export async function consumeSDKMessageStream(
  stream: AsyncGenerator<SDKMessage, void, unknown>,
  options: MessageMapperOptions,
): Promise<MessageStreamResult> {
  const state: StreamingState = {
    currentMessageId: null,
    partIndexToId: new Map(),
    toolUseIdToPartId: new Map(),
    inputJsonBuffers: new Map(),
    typeCounters: new Map(),
    lastUsage: null,
    terminalError: null,
  }

  for await (const message of stream) {
    mapMessage(message, options, state)
    if (message.type === "user") {
      const user = message as unknown as UserMessage
      if (!user.isCompactSummary && !user.isVisibleInTranscriptOnly && !user.isSynthetic) {
        options.onTurnBoundary?.()
      }
    }
  }
  return state.terminalError === null
    ? { ok: true }
    : { ok: false, message: state.terminalError, reported: true }
}

export function recomputeMessageProjections(
  messages: readonly Message[],
  options: MessageMapperOptions,
): void {
  options.store.setTodos(options.sessionId, [])
  options.store.setDiff({
    sessionId: options.sessionId,
    files: [],
    updatedAt: options.clock.now(),
  })
  for (const message of messages) {
    extractTodosAndDiffs(message.parts, options)
  }
}

function mapMessage(
  message: SDKMessage,
  options: MessageMapperOptions,
  state: StreamingState,
): void {
  const type = message.type as string
  switch (type) {
    case "system":
      mapSystemMessage(message, options)
      break
    case "assistant":
      mapAssistantMessage(message as unknown as AssistantMessage, options, state)
      break
    case "user":
      mapUserMessage(message as unknown as UserMessage, options)
      break
    case "stream_event":
      mapStreamEvent(message as unknown as StreamEventMessage, options, state)
      break
    case "tool_use_summary":
      // Tool use summaries are informational; tool status is already
      // updated via assistant/user messages. No-op for now.
      break
    case "tool_progress":
      mapToolProgress(message as unknown as ToolProgressMessage, options)
      break
    case "result":
      mapResultMessage(message as unknown as ResultMessage, options, state)
      break
    case "assistant_error":
      mapAssistantError(message, options, state)
      break
    default:
      break
  }
}

function mapSystemMessage(message: SDKMessage, options: MessageMapperOptions): void {
  const subtype = message.subtype as string | undefined
  if (subtype === "init") {
    const init = message as unknown as SystemInitMessage
    const currentStatus = options.store.getBundle(options.sessionId)?.status
    if (currentStatus?.type === "compacting") return
    batch(() => {
      options.store.setStatus(options.sessionId, {
        type: "working",
        model: init.model,
        usage: emptyUsage(),
        costUsd: 0,
      })
    })
  } else if (subtype === "compact_boundary") {
    // The boundary invalidates pre-compact edit anchors and clears transient
    // progress. Automatic compaction becomes working only at message_start;
    // manual /compact becomes idle when its result arrives.
    options.onCompactBoundary?.()
  } else if (subtype === "api_retry") {
    const retry = message as unknown as ApiRetryMessage
    options.store.setStatus(options.sessionId, {
      type: "retry",
      attempt: retry.attempt,
      maxRetries: retry.max_retries,
    })
  }
}

function mapAssistantMessage(
  message: AssistantMessage,
  options: MessageMapperOptions,
  state: StreamingState,
): void {
  const messageId = parseMessageId(message.message.id || message.uuid)
  const wasStreaming = state.currentMessageId !== null
  state.partIndexToId.clear()
  state.inputJsonBuffers.clear()

  const existingToolUseParts = new Map<string, Part>()
  if (wasStreaming && state.currentMessageId !== null) {
    const streamingBundle = options.store.getBundle(options.sessionId)
    const streamingMessage = streamingBundle?.messages.find((m) => m.id === state.currentMessageId)
    if (streamingMessage) {
      for (const p of streamingMessage.parts) {
        if (p.type === "tool_use") existingToolUseParts.set(p.id, p)
      }
    }
  }

  const parts: Part[] = []
  const content = message.message.content
  const compactSummary =
    message.message.model === "<synthetic>"
      ? extractCompactSummary(
          content
            .filter(
              (block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
            )
            .map((block) => block.text)
            .join("\n"),
        )
      : undefined
  let compactNotificationAdded = false
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block === undefined) continue
    // Use a type-relative index (count of preceding blocks of the same type)
    // so part IDs are stable between the streaming message and the final
    // assistant message, even after normalizeMessages splits multi-block
    // messages into single-block messages (each at content index 0).
    let typeIndex = 0
    for (let j = 0; j < i; j++) {
      if (content[j]?.type === block.type) typeIndex++
    }
    if (compactSummary !== undefined && block.type === "text") {
      if (compactSummary.notification === "" || compactNotificationAdded) continue
      compactNotificationAdded = true
    }
    const part = contentBlockToPart(
      compactSummary !== undefined && block.type === "text"
        ? { ...block, text: compactSummary.notification }
        : block,
      messageId,
      typeIndex,
    )
    if (part.type === "tool_use") {
      const existing = existingToolUseParts.get(part.id)
      if (existing && existing.type === "tool_use") {
        ;(part as { status: ToolStatusType }).status = existing.status
        ;(part as { output: unknown }).output = existing.output
        if (part.input === null || part.input === undefined) {
          ;(part as { input: unknown }).input = existing.input
        }
      } else {
        ;(part as { status: ToolStatusType }).status = "running"
      }
    }
    parts.push(part)
    state.partIndexToId.set(i, part.id)
    if (block.type === "tool_use") {
      state.toolUseIdToPartId.set(block.id, part.id)
    }
  }

  const msg: Message = {
    id: messageId,
    sessionId: options.sessionId,
    role: "assistant",
    parts,
    createdAt: options.clock.now(),
    ...(compactSummary !== undefined && { compactSummary }),
  }

  if (wasStreaming && state.currentMessageId !== null && state.currentMessageId !== messageId) {
    const streamingBundle = options.store.getBundle(options.sessionId)
    const streamingMessage = streamingBundle?.messages.find((m) => m.id === state.currentMessageId)
    if (streamingMessage) {
      const toolUseParts = streamingMessage.parts.filter(
        (p): p is Extract<Part, { type: "tool_use" }> => p.type === "tool_use",
      )
      const allToolUseCompleted =
        toolUseParts.length > 0 &&
        toolUseParts.every((p) => p.status === "completed" || p.status === "failed")
      if (allToolUseCompleted) {
        const hasThinkingInNew = parts.some((p) => p.type === "thinking")
        if (!hasThinkingInNew) {
          const streamingThinkingParts = streamingMessage.parts.filter((p) => p.type === "thinking")
          if (streamingThinkingParts.length > 0) {
            msg.parts = [...streamingThinkingParts, ...parts]
          }
        }
        options.store.addMessageBeforeQueued(msg)
      } else {
        const existingParts = streamingMessage.parts
        const newPartIds = new Set(parts.map((p) => p.id))
        const merged = existingParts.filter((p) => !newPartIds.has(p.id))
        const hasThinkingInNew = parts.some((p) => p.type === "thinking")
        if (!hasThinkingInNew) {
          const streamingThinkingParts = existingParts.filter((p) => p.type === "thinking")
          if (streamingThinkingParts.length > 0) {
            const thinkingIds = new Set(streamingThinkingParts.map((p) => p.id))
            const filtered = merged.filter((p) => !thinkingIds.has(p.id))
            msg.parts = [...streamingThinkingParts, ...filtered, ...parts]
          } else {
            msg.parts = [...merged, ...parts]
          }
        } else {
          msg.parts = [...merged, ...parts]
        }
        options.store.replaceMessage(options.sessionId, state.currentMessageId, msg)
      }
    } else {
      options.store.addMessageBeforeQueued(msg)
    }
  } else if (wasStreaming && state.currentMessageId === messageId) {
    const streamingBundle = options.store.getBundle(options.sessionId)
    const streamingMessage = streamingBundle?.messages.find((m) => m.id === state.currentMessageId)
    if (streamingMessage) {
      const existingParts = streamingMessage.parts
      const newPartIds = new Set(parts.map((p) => p.id))
      const merged = existingParts.filter((p) => !newPartIds.has(p.id))
      msg.parts = [...merged, ...parts]
      options.store.replaceMessage(options.sessionId, state.currentMessageId, msg)
    } else {
      options.store.addMessageBeforeQueued(msg)
    }
  } else {
    options.store.addMessageBeforeQueued(msg)
  }

  state.currentMessageId = messageId

  extractTodosAndDiffs(parts, options)
}

function mapUserMessage(message: UserMessage, options: MessageMapperOptions): void {
  const content = message.message.content
  if (message.isCompactSummary) {
    // Automatic-compaction summary: surface it in the UI instead of dropping
    // it. The text part carries the <compact-summary> marker so the TUI
    // renders a collapsible fold; the marker is UI-only — engine_event and
    // the model context keep the plain content.
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          updateToolUsePartStatus(
            options,
            block.tool_use_id,
            "completed",
            block.content,
            message.tool_use_result,
          )
        }
      }
    }
    if (typeof content === "string" && content.length > 0) {
      const messageId = parseMessageId(message.uuid)
      const part: Part = {
        type: "text",
        id: parsePartId(`part_text_${messageId}`),
        text: `<compact-summary>${content}</compact-summary>`,
      }
      const msg: Message = {
        id: messageId,
        sessionId: options.sessionId,
        role: "user",
        parts: [part],
        createdAt: options.clock.now(),
      }
      options.store.addMessage(msg)
    }
    return
  }
  if (message.isVisibleInTranscriptOnly || message.isSynthetic) {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          updateToolUsePartStatus(
            options,
            block.tool_use_id,
            "completed",
            block.content,
            message.tool_use_result,
          )
        }
      }
    }
    return
  }

  if (typeof content === "string") {
    const messageId = parseMessageId(message.uuid)
    const part: Part = {
      type: "text",
      id: parsePartId(`part_text_${messageId}`),
      text: content,
    }
    const msg: Message = {
      id: messageId,
      sessionId: options.sessionId,
      role: "user",
      parts: [part],
      createdAt: options.clock.now(),
    }
    options.store.addMessage(msg)
    return
  }

  for (const block of content) {
    if (block.type === "tool_result") {
      const toolUseId = block.tool_use_id
      const resultContent = block.content
      updateToolUsePartStatus(
        options,
        toolUseId,
        "completed",
        resultContent,
        message.tool_use_result,
      )
    }
  }

  const bundle = options.store.getBundle(options.sessionId)
  if (bundle !== undefined) {
    const allParts: Part[] = []
    for (const msg of bundle.messages) {
      allParts.push(...msg.parts)
    }
    extractDiffFromCompletedTools(allParts, options)
  }

  const parts: Part[] = content.map((block, i) =>
    contentBlockToPart(block, parseMessageId(message.uuid), i),
  )
  extractTodosAndDiffs(parts, options)
}

function mapStreamEvent(
  message: StreamEventMessage,
  options: MessageMapperOptions,
  state: StreamingState,
): void {
  const event = message.event
  switch (event.type) {
    case "message_start": {
      state.partIndexToId.clear()
      state.inputJsonBuffers.clear()
      state.typeCounters.clear()
      const rawId = (event.message as { id?: string } | undefined)?.id
      const messageId = parseMessageId(rawId || `msg_stream_${randomUUID()}`)
      state.currentMessageId = messageId
      const msg: Message = {
        id: messageId,
        sessionId: options.sessionId,
        role: "assistant",
        parts: [],
        createdAt: options.clock.now(),
      }
      options.store.addMessageBeforeQueued(msg)

      const startBundle = options.store.getBundle(options.sessionId)
      if (startBundle?.status.type === "compacting") {
        batch(() => {
          options.onCompactBoundary?.()
          options.store.setStatus(options.sessionId, {
            type: "working",
            model: startBundle.session.modelId,
            usage: emptyUsage(),
            costUsd: 0,
          })
        })
      }
      break
    }
    case "content_block_start": {
      if (!state.currentMessageId) break
      const block = event.content_block
      const typeKey = block.type
      const typeIndex = state.typeCounters.get(typeKey) ?? 0
      state.typeCounters.set(typeKey, typeIndex + 1)
      const part = contentBlockToPart(block, state.currentMessageId, typeIndex)
      state.partIndexToId.set(event.index, part.id)
      if (block.type === "tool_use") {
        state.toolUseIdToPartId.set(block.id, part.id)
      }
      options.store.addPart(options.sessionId, state.currentMessageId, part)
      if (block.type === "tool_use") {
        options.store.updatePart(options.sessionId, state.currentMessageId, part.id, (p: Part) => {
          if (p.type === "tool_use") return { ...p, status: "running" }
          return p
        })
      }
      break
    }
    case "content_block_delta": {
      if (!state.currentMessageId) break
      const partId = state.partIndexToId.get(event.index)
      if (!partId) break
      const delta = event.delta
      if (delta.type === "text_delta") {
        options.store.appendPartText(options.sessionId, state.currentMessageId, partId, delta.text)
      } else if (delta.type === "thinking_delta") {
        options.store.appendPartText(
          options.sessionId,
          state.currentMessageId,
          partId,
          delta.thinking,
        )
      } else if (delta.type === "input_json_delta") {
        const buf = state.inputJsonBuffers.get(event.index) ?? ""
        state.inputJsonBuffers.set(event.index, buf + delta.partial_json)
      } else if (delta.type === "signature_delta") {
        void 0
      }
      break
    }
    case "content_block_stop": {
      const buf = state.inputJsonBuffers.get(event.index)
      if (buf && state.currentMessageId) {
        const partId = state.partIndexToId.get(event.index)
        if (partId) {
          try {
            const parsed = JSON.parse(buf) as unknown
            options.store.updatePart(
              options.sessionId,
              state.currentMessageId,
              partId,
              (p: Part) => {
                if (p.type === "tool_use") return { ...p, input: parsed }
                return p
              },
            )
          } catch {
            // partial JSON may be incomplete; the full assistant message will replace it
          }
        }
      }
      state.inputJsonBuffers.delete(event.index)
      break
    }
    case "message_delta": {
      const eventWithUsage = event as {
        usage?: {
          input_tokens?: number
          output_tokens?: number
          reasoning_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
        delta?: {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            reasoning_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
      }
      const usage = eventWithUsage.usage ?? eventWithUsage.delta?.usage
      if (usage) {
        const bundle = options.store.getBundle(options.sessionId)
        if (bundle?.status.type === "working") {
          const u = usage
          options.store.setStatus(options.sessionId, {
            type: "working",
            model: bundle.status.model,
            usage: {
              inputTokens: u.input_tokens ?? bundle.status.usage.inputTokens,
              outputTokens: u.output_tokens ?? bundle.status.usage.outputTokens,
              reasoningTokens: u.reasoning_tokens ?? bundle.status.usage.reasoningTokens,
              cacheReadTokens: u.cache_read_input_tokens ?? bundle.status.usage.cacheReadTokens,
              cacheCreationTokens:
                u.cache_creation_input_tokens ?? bundle.status.usage.cacheCreationTokens,
              costUsd: bundle.status.usage.costUsd,
            },
            costUsd: bundle.status.costUsd,
          })
        }
      }
      break
    }
    case "message_stop":
      break
    default:
      break
  }
}

function mapResultMessage(
  message: ResultMessage,
  options: MessageMapperOptions,
  state: StreamingState,
): void {
  const bundle = options.store.getBundle(options.sessionId)
  const workingUsage = bundle?.status.type === "working" ? bundle.status.usage : undefined

  const rawUsage = parseUsage(
    message.usage,
    message.total_cost_usd,
    message.duration_ms,
    message.num_turns,
    message.stop_reason,
  )

  // result.usage is accumulated across all turns (totalUsage in QueryEngine).
  // For context-percentage display we need the current message's token counts,
  // which message_delta already delivered to the working state. Prefer those.
  // When status is "compacting" (manual /compact with shouldQuery=false), no
  // API call followed, so totalUsage is the stale pre-compaction accumulated
  // total — reset to empty so the status bar doesn't show a wrong percentage.
  const usage =
    workingUsage !== undefined
      ? {
          ...rawUsage,
          inputTokens: workingUsage.inputTokens,
          outputTokens: workingUsage.outputTokens,
          reasoningTokens: workingUsage.reasoningTokens,
          cacheReadTokens: workingUsage.cacheReadTokens,
          cacheCreationTokens: workingUsage.cacheCreationTokens,
        }
      : bundle?.status.type === "compacting"
        ? emptyUsage()
        : rawUsage

  state.lastUsage = usage
  batch(() => {
    options.store.setStatus(options.sessionId, {
      type: "idle",
      lastUsage: usage,
    })
  })
  if (message.is_error) {
    // Prefer the structured errors[] array; fall back to the result text
    // (API errors via subtype:"success" + is_error:true carry the message in
    // `result`, not `errors`). Only emit the generic fallback when both are absent.
    const fromErrors = extractFirstErrorMessage(message.errors)
    const errorText =
      fromErrors !== "An error occurred during execution"
        ? fromErrors
        : (message.result ?? "An error occurred during execution")
    state.terminalError = errorText

    // If the previous assistant message already carries this exact error text
    // (the synthetic API-error assistant message path), don't create a duplicate
    // bubble — just record the terminal error for the stream result.
    const bundle = options.store.getBundle(options.sessionId)
    const lastAssistant = bundle?.messages.findLast((m) => m.role === "assistant")
    const alreadySurfaced = lastAssistant?.parts.some(
      (p) => p.type === "text" && p.text === errorText,
    )
    if (!alreadySurfaced) {
      const messageId = parseMessageId(`msg_error_${randomUUID()}`)
      const msg: Message = {
        id: messageId,
        sessionId: options.sessionId,
        role: "assistant",
        parts: [{ type: "text", id: parsePartId(`part_text_${messageId}`), text: errorText }],
        createdAt: options.clock.now(),
        error: errorText,
      }
      options.store.addMessageBeforeQueued(msg)
    }
  }
}

function mapAssistantError(
  message: SDKMessage,
  options: MessageMapperOptions,
  state: StreamingState,
): void {
  const error = (message as unknown as { error: unknown }).error
  const errorText = formatErrorText(error)
  state.terminalError = errorText

  if (state.currentMessageId !== null) {
    const streamingBundle = options.store.getBundle(options.sessionId)
    const streamingMessage = streamingBundle?.messages.find((m) => m.id === state.currentMessageId)
    if (streamingMessage) {
      for (const part of streamingMessage.parts) {
        if (part.type === "tool_use" && (part.status === "running" || part.status === "pending")) {
          options.store.updatePart(options.sessionId, streamingMessage.id, part.id, (p: Part) => {
            if (p.type === "tool_use") return { ...p, status: "failed" as ToolStatusType }
            return p
          })
        }
      }
    }
  }

  const messageId = parseMessageId(`msg_error_${randomUUID()}`)
  const msg: Message = {
    id: messageId,
    sessionId: options.sessionId,
    role: "assistant",
    // No text part: the TUI renders `message.error` in a dedicated error box.
    // Putting the same text in both `parts` and `error` caused it to render twice.
    parts: [],
    createdAt: options.clock.now(),
    error: errorText,
  }
  batch(() => {
    options.store.addMessageBeforeQueued(msg)
    options.store.setStatus(options.sessionId, { type: "idle" })
  })
  state.currentMessageId = null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentBlockToPart(block: ContentBlock, messageId: Message["id"], index: number): Part {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        id: parsePartId(`part_text_${messageId}_${index}`),
        text: block.text,
      }
    case "thinking":
      return {
        type: "thinking",
        id: parsePartId(`part_thinking_${messageId}_${index}`),
        text: block.thinking,
        signature: block.signature,
      }
    case "tool_use":
      return {
        type: "tool_use",
        id: parsePartId(`part_tool_${block.id}`),
        toolName: block.name,
        input: block.input,
        status: "pending",
      }
    case "tool_result":
      return {
        type: "tool_result",
        id: parsePartId(`part_result_${block.tool_use_id}`),
        toolUseId: block.tool_use_id,
        content: block.content,
      }
    default:
      console.warn("Unknown content block type:", (block as { type?: string }).type ?? "unknown")
      return {
        type: "text" as const,
        id: parsePartId(`part_text_${messageId}_${index}`),
        text: "",
      }
  }
}

function updateToolUsePartStatus(
  options: MessageMapperOptions,
  toolUseId: string,
  status: ToolStatusType,
  output: unknown,
  nativeResult?: unknown,
): void {
  const targetPartId = parsePartId(`part_tool_${toolUseId}`)
  const bundle = options.store.getBundle(options.sessionId)
  if (!bundle) return
  // Iterate in reverse — tool_use parts are typically in the most recent messages
  for (let i = bundle.messages.length - 1; i >= 0; i--) {
    const message = bundle.messages[i]
    if (message === undefined) continue
    for (const part of message.parts) {
      if (part.type === "tool_use" && part.id === targetPartId) {
        options.store.updatePart(options.sessionId, message.id, part.id, (p: Part) => {
          if (p.type === "tool_use") {
            const agentId = extractAgentId(nativeResult) ?? extractAgentId(output)
            return {
              ...p,
              status,
              output,
              ...(agentId !== undefined && { agentId }),
            }
          }
          return p
        })
        return
      }
    }
  }
}

function extractAgentId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const match = value.match(/agentId:\s*(\S+)/)
    return match?.[1]
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const agentId = extractAgentId(item)
      if (agentId !== undefined) return agentId
    }
    return undefined
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (typeof record.agentId === "string") return record.agentId
    if (record.type === "text" && typeof record.text === "string") {
      const match = record.text.match(/agentId:\s*(\S+)/)
      return match?.[1]
    }
  }
  return undefined
}

function mapToolProgress(message: ToolProgressMessage, options: MessageMapperOptions): void {
  // Handle agent_started progress — attach agentId to the running tool_use
  // part so the TUI can navigate to the subagent transcript while it's
  // still working (not just after completion).
  if (!message.agentId) return
  const targetPartId = parsePartId(`part_tool_${message.tool_use_id}`)
  const bundle = options.store.getBundle(options.sessionId)
  if (!bundle) return
  for (let i = bundle.messages.length - 1; i >= 0; i--) {
    const msg = bundle.messages[i]
    if (msg === undefined) continue
    for (const part of msg.parts) {
      if (part.type === "tool_use" && part.id === targetPartId) {
        options.store.updatePart(options.sessionId, msg.id, part.id, (p: Part) => {
          if (p.type === "tool_use" && p.agentId === undefined) {
            return { ...p, agentId: message.agentId }
          }
          return p
        })
        return
      }
    }
  }
}

function parseUsage(
  raw: Record<string, unknown>,
  costUsd: number,
  durationMs?: number,
  numTurns?: number,
  stopReason?: string | null,
): Usage {
  const inputTokens = numKey(raw, "input_tokens")
  const outputTokens = numKey(raw, "output_tokens")
  const cacheReadTokens = numKey(raw, "cache_read_input_tokens")
  const cacheCreationTokens = numKey(raw, "cache_creation_input_tokens")
  const reasoningTokens = numKey(raw, "reasoning_tokens")
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    durationMs,
    numTurns,
    stopReason,
  }
}

function numKey(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === "number" ? value : 0
}

function extractFirstErrorMessage(errors: string[] | undefined): string {
  if (errors === undefined || errors.length === 0) return "An error occurred during execution"
  const first = errors[0] as unknown
  if (typeof first === "string") return first
  if (first !== null && typeof first === "object") {
    const obj = first as Record<string, unknown>
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.error === "string") return obj.error
  }
  return "An error occurred during execution"
}

function formatErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === "object") {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.error === "string") return obj.error
    return "An unexpected error occurred"
  }
  return String(error)
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  }
}

type DiffStats = { added: number; removed: number; patch?: string }

/**
 * Compute added/removed line counts from an Edit tool's old_string/new_string.
 * The engine's mapToolResultToToolResultBlockParam discards structuredPatch when
 * converting tool output to the API-facing tool_result.content, so the adapter
 * can only recover diff stats by re-running the diff from the tool's input.
 */
function computeEditDiffStats(oldStr: string, newStr: string): DiffStats {
  if (oldStr === newStr) return { added: 0, removed: 0 }
  const result = structuredPatch("old", "new", oldStr, newStr, undefined, undefined, { context: 3 })
  let added = 0
  let removed = 0
  for (const hunk of result.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++
      else if (line.startsWith("-")) removed++
    }
  }
  return { added, removed, patch: JSON.stringify(result.hunks) }
}

/**
 * Try to extract diff stats from a completed edit/write tool part.
 * Prefers structuredPatch embedded in the tool output (rare — only when the
 * tool result content is the raw JSON); falls back to computing from input.
 */
function extractDiffStats(part: Part): DiffStats | null {
  if (part.type !== "tool_use" || part.status !== "completed") return null
  const input = part.input as Record<string, unknown> | null
  if (input === null || typeof input !== "object") return null

  const lower = part.toolName.toLowerCase()
  const isEdit = lower.includes("edit")
  const isWrite = lower.includes("write")
  if (!isEdit && !isWrite) return null

  // Edit: compute from old_string/new_string directly.
  if (isEdit) {
    const oldStr = typeof input.old_string === "string" ? input.old_string : undefined
    const newStr = typeof input.new_string === "string" ? input.new_string : undefined
    if (oldStr !== undefined && newStr !== undefined) {
      return computeEditDiffStats(oldStr, newStr)
    }
  }

  // Write: only counts for updates (originalFile present in tool output JSON).
  // New-file writes have no diff to compute.
  if (isWrite && part.output !== undefined) {
    const outputStr =
      typeof part.output === "string"
        ? part.output
        : typeof part.output === "object" && part.output !== null
          ? safeStringify(part.output)
          : ""
    if (outputStr !== "") {
      try {
        const parsed = JSON.parse(outputStr) as Record<string, unknown>
        if (typeof parsed.originalFile === "string" && typeof input.content === "string") {
          return computeEditDiffStats(parsed.originalFile, input.content)
        }
      } catch {
        // output is not JSON; nothing to compute
      }
    }
  }
  return null
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function extractCompactSummary(text: string): Message["compactSummary"] | undefined {
  const match = text.match(/^([\s\S]*?)<compact-summary>([\s\S]*?)<\/compact-summary>/)
  if (!match) return undefined
  return {
    notification: (match[1] ?? "").trim(),
    summary: (match[2] ?? "").trim(),
  }
}

function extractTodosAndDiffs(parts: readonly Part[], options: MessageMapperOptions): void {
  for (const part of parts) {
    if (part.type !== "tool_use") continue
    const input = part.input as Record<string, unknown> | null
    if (input === null || typeof input !== "object") continue

    if (part.toolName === "TodoWrite" || part.toolName === "TodoWriteTool") {
      const todosRaw = input.todos
      if (Array.isArray(todosRaw)) {
        const todos: Todo[] = todosRaw
          .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
          .map((t) => ({
            id: String(t.id ?? `todo_${Math.random().toString(36).slice(2)}`),
            sessionId: options.sessionId,
            status: String(t.status ?? "pending") as Todo["status"],
            content: String(t.content ?? ""),
          }))
        options.store.setTodos(options.sessionId, todos)
      }
    }

    const lower = part.toolName.toLowerCase()
    if (lower.includes("edit") || lower.includes("write")) {
      const filePath = String(input.filePath ?? input.file_path ?? input.path ?? "")
      if (filePath) {
        const bundle = options.store.getBundle(options.sessionId)
        const existing = bundle?.diff ?? []
        const stats = extractDiffStats(part)
        const alreadyTracked = existing.some((f) => f.path === filePath)
        if (!alreadyTracked) {
          const added = stats?.added ?? 0
          const removed = stats?.removed ?? 0
          const patch = stats?.patch
          const newDiff: SnapshotFileDiff[] = [
            ...existing,
            { path: filePath, added, removed, ...(patch !== undefined && { patch }) },
          ]
          const diff: Diff = {
            sessionId: options.sessionId,
            files: newDiff,
            updatedAt: options.clock.now(),
          }
          options.store.setDiff(diff)
        } else {
          const idx = existing.findIndex((f) => f.path === filePath)
          if (idx >= 0) {
            const existing_ = existing[idx]
            if (existing_ && stats !== null) {
              const newDiff = [...existing]
              newDiff[idx] = {
                path: filePath,
                added: stats.added,
                removed: stats.removed,
                ...(stats.patch !== undefined && { patch: stats.patch }),
              }
              options.store.setDiff({
                sessionId: options.sessionId,
                files: newDiff,
                updatedAt: options.clock.now(),
              })
            }
          }
        }
      }
    }
  }
}

function extractDiffFromCompletedTools(
  parts: readonly Part[],
  options: MessageMapperOptions,
): void {
  for (const part of parts) {
    if (part.type !== "tool_use") continue
    if (part.status !== "completed") continue
    const input = part.input as Record<string, unknown> | null
    if (input === null || typeof input !== "object") continue
    const lower = part.toolName.toLowerCase()
    if (!lower.includes("edit") && !lower.includes("write")) continue
    const filePath = String(input.filePath ?? input.file_path ?? input.path ?? "")
    if (!filePath) continue
    const bundle = options.store.getBundle(options.sessionId)
    const existing = bundle?.diff ?? []
    const idx = existing.findIndex((f) => f.path === filePath)
    if (idx < 0) continue
    const existingEntry = existing[idx]
    if (!existingEntry || existingEntry.added > 0 || existingEntry.removed > 0) continue
    const stats = extractDiffStats(part)
    if (stats === null) continue
    const newDiff = [...existing]
    newDiff[idx] = {
      path: filePath,
      added: stats.added,
      removed: stats.removed,
      ...(stats.patch !== undefined && { patch: stats.patch }),
    }
    options.store.setDiff({
      sessionId: options.sessionId,
      files: newDiff,
      updatedAt: options.clock.now(),
    })
  }
}

// Re-export for test fixtures and adapter layer
export function createPermissionRequest(
  sessionId: SessionId,
  toolName: string,
  input: unknown,
  displayType: PermissionDisplayType,
) {
  return {
    id: parsePermissionId(`perm_${randomUUID()}`),
    sessionId,
    toolName,
    input,
    displayType,
  }
}

export type { SDKMessage }

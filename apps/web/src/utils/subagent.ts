import type { Message } from "@wren/protocol"

/** Unique subagent ids referenced by tool_use parts across messages. */
export function useSubagentIds(messages: readonly Message[]): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_use" && part.agentId !== undefined) ids.add(part.agentId)
    }
  }
  return [...ids]
}

type UsageBlock = {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

type ToolUseBlock = {
  readonly type?: string
  readonly name?: string
  readonly input?: { todos?: readonly { status?: string }[] }
}

type TranscriptMessage = {
  readonly message?: {
    readonly usage?: UsageBlock
    readonly model?: string
    readonly content?: readonly ToolUseBlock[]
  }
}

export type SubagentHeader = {
  readonly model: string | undefined
  readonly tokenTotal: number
  readonly todo: { completed: number; total: number } | undefined
}

/**
 * Derives the subagent header (model, token total, latest todo summary) from
 * the raw transcript returned by /session/:sid/subagent/:agentId, mirroring
 * the TUI's subagent route.
 */
export function deriveSubagentHeader(messages: readonly unknown[]): SubagentHeader {
  let model: string | undefined
  let tokenTotal = 0
  let todo: { completed: number; total: number } | undefined

  for (const raw of messages) {
    const message = (raw as TranscriptMessage | undefined)?.message
    if (message === undefined) continue
    if (message.usage !== undefined) {
      tokenTotal =
        (message.usage.input_tokens ?? 0) +
        (message.usage.output_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0)
    }
    if (model === undefined && typeof message.model === "string" && message.model !== "") {
      model = message.model
    }
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== "tool_use") continue
      const name = block.name?.toLowerCase()
      if (name !== "todowrite" && name !== "todowritetool") continue
      const todos = block.input?.todos
      if (!Array.isArray(todos)) continue
      const total = todos.length
      const completed = todos.filter((t) => t?.status === "completed").length
      todo = { completed, total }
    }
  }
  return { model, tokenTotal, todo }
}

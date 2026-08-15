import type { Message, ToolStatusType } from "@wren/protocol"

export type SubagentInfo = {
  id: string
  label: string
  agentType: string
  status: ToolStatusType
  startedAt: string
  agentId?: string | undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isWorking(status: ToolStatusType): boolean {
  return status === "running" || status === "pending"
}

/** Subagent infos from tool_use parts (Agent tool only). */
export function useSubagentInfos(messages: readonly Message[]): SubagentInfo[] {
  const map = new Map<string, SubagentInfo>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_use") continue
      if (part.toolName.toLowerCase() !== "agent") continue
      const input = recordValue(part.input)
      const agentId = part.agentId
      const description = stringValue(input?.description) ?? stringValue(input?.prompt) ?? "Agent"
      const agentType = stringValue(input?.subagent_type) ?? "general-purpose"
      const key = agentId ?? part.id
      if (map.has(key)) continue
      map.set(key, {
        id: agentId ?? part.id,
        label: description,
        agentType,
        status: part.status,
        startedAt: message.createdAt,
        agentId,
      })
    }
  }
  return [...map.values()]
}

/** Split subagents into working and retired groups. */
export function splitSubagentGroups(infos: readonly SubagentInfo[]): {
  working: SubagentInfo[]
  retired: SubagentInfo[]
} {
  return {
    working: infos.filter((s) => isWorking(s.status)),
    retired: infos.filter((s) => !isWorking(s.status)).reverse(),
  }
}

/** Unique subagent ids referenced by tool_use parts across messages. */
export function useSubagentIds(messages: readonly Message[]): string[] {
  return useSubagentInfos(messages).map((s) => s.id)
}

// --- Legacy types/functions for deriveSubagentHeader (subagent view) ---

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

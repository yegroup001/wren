import type { PermissionDisplayType, Session, Usage } from "@wren/protocol"

// HTTP helpers + payload parsers for the local adapter. Pure functions,
// no closure state, so they live separate from the adapter factory.

export type PermissionReply = "once" | "session" | "deny"

export type CreateSessionBody = {
  readonly cwd: string
  readonly modelId?: string | undefined
  readonly permissionMode?: string | undefined
  readonly effort?: Session["effort"]
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function notFound(code: string, message: string): Response {
  return json({ error: code, message }, 404)
}

export async function readJson(request: Request): Promise<unknown> {
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "DELETE") return undefined
  const text = await request.text()
  if (text === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function workingStatus(model: string): {
  readonly type: "working"
  readonly model: string
  readonly usage: Usage
  readonly costUsd: number
} {
  return {
    type: "working",
    model,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    },
    costUsd: 0,
  }
}

export function parseCreateSessionBody(body: unknown): CreateSessionBody {
  if (body === null || typeof body !== "object") {
    throw new AdapterPayloadError("invalid session body")
  }
  const record = body as Record<string, unknown>
  const cwd = record.cwd
  if (typeof cwd !== "string" || cwd === "") {
    throw new AdapterPayloadError("cwd is required")
  }
  const effort = record.effort
  if (
    effort !== undefined &&
    effort !== "default" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  ) {
    throw new AdapterPayloadError("effort must be default|low|medium|high|xhigh|max")
  }
  return {
    cwd,
    modelId: typeof record.modelId === "string" ? (record.modelId as string) : undefined,
    permissionMode:
      typeof record.permissionMode === "string" ? (record.permissionMode as string) : undefined,
    effort: effort as Session["effort"],
  }
}

export type PromptBody = {
  readonly prompt: string
  readonly editMessageId?: string | undefined
  /** Suppresses automatic Goal continuation after this explicit prompt completes. */
  readonly disableGoalContinuation?: boolean | undefined
}

export function parsePromptBody(body: unknown): PromptBody {
  if (body === null || typeof body !== "object") {
    throw new AdapterPayloadError("invalid prompt body")
  }
  const record = body as Record<string, unknown>
  const prompt = record.prompt
  if (typeof prompt !== "string" || prompt === "") {
    throw new AdapterPayloadError("prompt is required")
  }
  const editMessageId = record.editMessageId
  if (editMessageId !== undefined && (typeof editMessageId !== "string" || editMessageId === "")) {
    throw new AdapterPayloadError("editMessageId must be a non-empty string")
  }
  const disableGoalContinuation = record.disableGoalContinuation
  if (disableGoalContinuation !== undefined && typeof disableGoalContinuation !== "boolean") {
    throw new AdapterPayloadError("disableGoalContinuation must be a boolean")
  }
  return {
    prompt,
    ...(editMessageId !== undefined && { editMessageId }),
    ...(disableGoalContinuation !== undefined && { disableGoalContinuation }),
  }
}

export type ModelBody = {
  readonly modelId: string
  readonly reasoning?: unknown
}

export function parseModelBody(body: unknown): ModelBody {
  if (body === null || typeof body !== "object") {
    throw new AdapterPayloadError("invalid model body")
  }
  const record = body as Record<string, unknown>
  const modelId = record.modelId
  if (typeof modelId !== "string" || modelId === "") {
    throw new AdapterPayloadError("modelId is required")
  }
  const reasoning = record.reasoning
  return { modelId, reasoning }
}

export function parsePermissionModeBody(body: unknown): string {
  if (body === null || typeof body !== "object") {
    throw new AdapterPayloadError("invalid permission mode body")
  }
  const permissionMode = (body as Record<string, unknown>).permissionMode
  if (typeof permissionMode !== "string" || permissionMode === "") {
    throw new AdapterPayloadError("permissionMode is required")
  }
  return permissionMode
}

export function parsePermissionReply(body: unknown): PermissionReply {
  if (body !== null && typeof body === "object") {
    const response = (body as Record<string, unknown>).response
    if (response === "once" || response === "session" || response === "deny") {
      return response
    }
  }
  throw new AdapterPayloadError("response must be once|session|deny")
}

type GoalAction = "status" | "set" | "clear" | "pause" | "resume" | "complete" | "continue"

export type GoalBody = { readonly action: GoalAction; readonly objective?: string }

export function parseGoalBody(body: unknown): GoalBody {
  if (body === null || typeof body !== "object") throw new AdapterPayloadError("invalid goal body")
  const record = body as Record<string, unknown>
  const action = record.action
  if (
    action !== "status" &&
    action !== "set" &&
    action !== "clear" &&
    action !== "pause" &&
    action !== "resume" &&
    action !== "complete" &&
    action !== "continue"
  ) {
    throw new AdapterPayloadError("invalid goal action")
  }
  const objective = record.objective
  if (action === "set" && (typeof objective !== "string" || objective.trim() === "")) {
    throw new AdapterPayloadError("objective is required")
  }
  return typeof objective === "string" ? { action, objective: objective.trim() } : { action }
}

const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"])
type SessionEffort = Exclude<Session["effort"], undefined>

export function parseEffortBody(body: unknown): SessionEffort {
  if (body === null || typeof body !== "object") {
    throw new AdapterPayloadError("invalid effort body")
  }
  const effort = (body as Record<string, unknown>).effort
  if (typeof effort !== "string" || !EFFORT_VALUES.has(effort)) {
    throw new AdapterPayloadError("effort must be low|medium|high|xhigh|max")
  }
  return effort as SessionEffort
}

export type QuestionReply =
  | { readonly answers: readonly string[]; readonly rejected: false }
  | { readonly answers: null; readonly rejected: true }

export function parseQuestionReply(body: unknown): QuestionReply {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>
    const rejected = record.rejected === true
    const answersRaw = record.answers
    if (Array.isArray(answersRaw) && answersRaw.every((a) => typeof a === "string")) {
      if (rejected) return { answers: null, rejected: true }
      if (answersRaw.length > 0) return { answers: answersRaw, rejected: false }
    }
  }
  throw new AdapterPayloadError("answers must be a string array")
}

export function inferDisplayType(toolName: string): PermissionDisplayType {
  const lower = toolName.toLowerCase()
  if (lower === "bash" || lower === "bashtool") return "bash"
  if (lower === "edit" || lower === "fileedittool" || lower === "edittool") return "edit"
  if (
    lower === "write" ||
    lower === "filewritetool" ||
    lower === "writetool" ||
    lower === "notebookedittool"
  )
    return "write"
  if (lower === "read" || lower === "filereadtool" || lower === "readtool") return "read"
  if (lower === "glob" || lower === "globtool") return "glob"
  if (lower === "grep" || lower === "greptool") return "grep"
  if (lower === "todowrite" || lower === "todowritetool") return "default"
  if (lower === "askuserquestion") return "default"
  if (lower === "webfetch" || lower === "webfetchtool") return "webfetch"
  if (lower === "websearch" || lower === "websearchtool") return "websearch"
  if (lower.includes("bash")) return "bash"
  if (lower.includes("edit")) return "edit"
  if (lower.includes("write")) return "write"
  if (lower.includes("read")) return "read"
  if (lower.includes("agent") || lower.includes("task")) return "task"
  return "default"
}

const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "filereadtool",
  "readtool",
  "glob",
  "globtool",
  "grep",
  "greptool",
  "webfetch",
  "webfetchtool",
  "websearch",
  "websearchtool",
  "todowrite",
  "todowritetool",
  "localmemoryrecall",
  "ctxinspect",
  "enterplanmode",
  "exitplanmode",
])

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName.toLowerCase())
}

const FILE_EDIT_TOOL_NAMES = new Set([
  "edit",
  "fileedittool",
  "edittool",
  "write",
  "filewritetool",
  "writetool",
  "notebookedit",
  "notebookedittool",
])

export function isFileEditTool(toolName: string): boolean {
  return FILE_EDIT_TOOL_NAMES.has(toolName.toLowerCase())
}

export class AdapterPayloadError extends Error {
  readonly name = "AdapterPayloadError"
}

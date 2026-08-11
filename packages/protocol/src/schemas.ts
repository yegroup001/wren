import { z } from "zod"
import {
  MESSAGE_ROLES,
  PART_TYPES,
  PERMISSION_DISPLAY_TYPES,
  SESSION_STATUS_TYPES,
  TODO_STATUS_TYPES,
  TOOL_STATUS_TYPES,
} from "./constants"
import {
  MessageIdSchema,
  PartIdSchema,
  PermissionIdSchema,
  RequestIdSchema,
  SessionIdSchema,
} from "./ids"
import { SelectedModelReferenceSchema } from "./model-contract"

// ---------------------------------------------------------------------------
// Model / Provider / Command metadata (used by TUI pickers)
// ---------------------------------------------------------------------------

export const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextLimit: z.number().int().positive(),
})

export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.record(z.string().min(1), ModelSchema),
})

export const CommandSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Usage — token consumption from a turn (maps from BetaUsage)
// ---------------------------------------------------------------------------

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().optional(),
  numTurns: z.number().optional(),
  stopReason: z.string().nullable().optional(),
})

// ---------------------------------------------------------------------------
// Session — a conversation backed by a real QueryEngine instance
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  id: SessionIdSchema,
  cwd: z.string().min(1),
  modelId: z.string().min(1),
  modelRef: SelectedModelReferenceSchema.optional(),
  permissionMode: z.string().min(1),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).optional(),
})

// ---------------------------------------------------------------------------
// Status — per-session reactive status (idle / working / compacting / retry)
// ---------------------------------------------------------------------------

export const StatusSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(SESSION_STATUS_TYPES[0]),
    lastUsage: UsageSchema.optional(),
  }),
  z.object({
    type: z.literal(SESSION_STATUS_TYPES[1]),
    model: z.string().min(1),
    usage: UsageSchema,
    costUsd: z.number().nonnegative(),
  }),
  z.object({ type: z.literal(SESSION_STATUS_TYPES[2]) }),
  z.object({
    type: z.literal(SESSION_STATUS_TYPES[3]),
    attempt: z.number().int().nonnegative(),
    maxRetries: z.number().int().nonnegative(),
  }),
])

// ---------------------------------------------------------------------------
// Part — discriminated union of content blocks inside a Message
// Maps from the SDK ContentBlock variants
// ---------------------------------------------------------------------------

export const PartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(PART_TYPES[0]),
    id: PartIdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal(PART_TYPES[1]),
    id: PartIdSchema,
    text: z.string(),
    signature: z.string().optional(),
  }),
  z.object({
    type: z.literal(PART_TYPES[2]),
    id: PartIdSchema,
    toolName: z.string().min(1),
    input: z.unknown(),
    status: z.enum(TOOL_STATUS_TYPES),
    output: z.unknown().optional(),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal(PART_TYPES[3]),
    id: PartIdSchema,
    toolUseId: z.string().min(1),
    content: z.unknown(),
  }),
])

// ---------------------------------------------------------------------------
// Message — a single user/assistant/system turn with embedded parts
// ---------------------------------------------------------------------------

export const MessageSchema = z.object({
  id: MessageIdSchema,
  sessionId: SessionIdSchema,
  role: z.enum(MESSAGE_ROLES),
  parts: z.array(PartSchema),
  createdAt: z.string().datetime(),
  error: z.string().optional(),
  queued: z.boolean().optional(),
  compactSummary: z
    .object({
      notification: z.string(),
      summary: z.string(),
    })
    .optional(),
})

// ---------------------------------------------------------------------------
// PermissionRequest — triggers the TUI permission modal
// ---------------------------------------------------------------------------

export const PermissionRequestSchema = z.object({
  id: PermissionIdSchema,
  sessionId: SessionIdSchema,
  toolName: z.string().min(1),
  input: z.unknown(),
  displayType: z.enum(PERMISSION_DISPLAY_TYPES),
})

// ---------------------------------------------------------------------------
// Todo — from TodoWrite tool
// ---------------------------------------------------------------------------

export const TodoSchema = z.object({
  id: z.string().min(1),
  sessionId: SessionIdSchema,
  status: z.enum(TODO_STATUS_TYPES),
  content: z.string().min(1),
  activeForm: z.string().optional(),
})

// ---------------------------------------------------------------------------
// QuestionRequest — TUI question modal (kept for backward compat)
// ---------------------------------------------------------------------------

export const QuestionRequestSchema = z.object({
  id: RequestIdSchema,
  sessionId: SessionIdSchema,
  title: z.string().min(1),
  detail: z.string(),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })),
  multiSelect: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// Diff — file change summary for a session
// ---------------------------------------------------------------------------

export const SnapshotFileDiffSchema = z.object({
  path: z.string().min(1),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  patch: z.string().optional(),
})

export const DiffSchema = z.object({
  sessionId: SessionIdSchema,
  files: z.array(SnapshotFileDiffSchema),
  updatedAt: z.string().datetime(),
})

// ---------------------------------------------------------------------------
// Session preview — compact metadata for identifying an unloaded session
// ---------------------------------------------------------------------------

export const SessionPreviewSchema = z.object({
  createdAt: z.string().datetime(),
  text: z.string(),
})

// ---------------------------------------------------------------------------
// SessionBundle — serialized session state for persistence
// ---------------------------------------------------------------------------

export const SessionBundleSchema = z.object({
  session: SessionSchema,
  status: StatusSchema,
  messages: z.array(MessageSchema),
  todos: z.array(TodoSchema),
  permissions: z.array(PermissionRequestSchema),
  diff: z.array(SnapshotFileDiffSchema),
})

// ---------------------------------------------------------------------------
// GlobalEvent — event bus events for the adapter layer
// ---------------------------------------------------------------------------

export const GlobalEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("server.connected") }),
  z.object({ type: z.literal("server.heartbeat") }),
  z.object({ type: z.literal("provider.updated"), provider: ProviderSchema }),
  z.object({ type: z.literal("model.updated"), model: ModelSchema }),
  z.object({ type: z.literal("command.updated"), command: CommandSchema }),
  z.object({ type: z.literal("session.created"), session: SessionSchema }),
  z.object({ type: z.literal("session.updated"), session: SessionSchema }),
  z.object({
    type: z.literal("session.status.updated"),
    sessionId: SessionIdSchema,
    status: StatusSchema,
  }),
  z.object({ type: z.literal("message.updated"), message: MessageSchema }),
  z.object({
    type: z.literal("todo.updated"),
    sessionId: SessionIdSchema,
    todos: z.array(TodoSchema),
  }),
  z.object({ type: z.literal("diff.updated"), diff: DiffSchema }),
  z.object({
    type: z.literal("permission.asked"),
    request: PermissionRequestSchema,
  }),
  z.object({
    type: z.literal("permission.replied"),
    requestId: PermissionIdSchema,
  }),
  z.object({
    type: z.literal("question.asked"),
    request: QuestionRequestSchema,
  }),
  z.object({
    type: z.literal("question.answered"),
    requestId: RequestIdSchema,
  }),
])

export const EventEnvelopeSchema = z.object({
  id: RequestIdSchema,
  directory: z.string().min(1),
  payload: GlobalEventSchema,
  workspace: z.string().min(1).optional(),
})

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type Provider = z.infer<typeof ProviderSchema>
export type Model = z.infer<typeof ModelSchema>
export type Command = z.infer<typeof CommandSchema>
export type Usage = z.infer<typeof UsageSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionPreview = z.infer<typeof SessionPreviewSchema>
export type Status = z.infer<typeof StatusSchema>
export type Message = z.infer<typeof MessageSchema>
export type Part = z.infer<typeof PartSchema>
export type Todo = z.infer<typeof TodoSchema>
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>
export type SnapshotFileDiff = z.infer<typeof SnapshotFileDiffSchema>
export type Diff = z.infer<typeof DiffSchema>
export type SessionBundle = z.infer<typeof SessionBundleSchema>
export type GlobalEvent = z.infer<typeof GlobalEventSchema>
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>

import { z } from "zod"
import {
  DiffSchema,
  MessageSchema,
  PermissionRequestSchema,
  QuestionRequestSchema,
  SessionPreviewSchema,
  SessionSchema,
  StatusSchema,
  TodoSchema,
} from "./schemas"

// ---------------------------------------------------------------------------
// Web GUI transport contract — shared between the CLI web server and the
// browser frontend (apps/web). Mirrors the adapter TuiStore shape so the
// server can serialize adapter.state directly and the browser can apply
// patches to an identical local store.
// ---------------------------------------------------------------------------

export const CompactProgressSegmentSchema = z.object({
  type: z.enum(["text", "thinking"]),
  text: z.string(),
})

export const CompactProgressSchema = z.object({
  phase: z.enum(["preparing", "summarizing", "finalizing"]),
  segments: z.array(CompactProgressSegmentSchema),
})

export const WebStateSnapshotSchema = z.object({
  sessions: z.array(SessionSchema),
  titles: z.record(z.string(), z.string()),
  previews: z.record(z.string(), SessionPreviewSchema),
  messages: z.record(z.string(), z.array(MessageSchema)),
  permissions: z.record(z.string(), z.array(PermissionRequestSchema)),
  questions: z.record(z.string(), z.array(QuestionRequestSchema)),
  todos: z.record(z.string(), z.array(TodoSchema)),
  status: z.record(z.string(), StatusSchema),
  diffs: z.record(z.string(), DiffSchema),
  compactProgress: z.record(z.string(), CompactProgressSchema.optional()),
})

export const MessagePatchSchema = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(["upsert", "replaceAll"]),
  messages: z.array(MessageSchema),
})

export const WebStatePatchSchema = z.object({
  sessions: z.array(SessionSchema).optional(),
  titles: z.record(z.string(), z.string()).optional(),
  previews: z.record(z.string(), SessionPreviewSchema).optional(),
  todos: z.record(z.string(), z.array(TodoSchema)).optional(),
  status: z.record(z.string(), StatusSchema).optional(),
  diffs: z.record(z.string(), DiffSchema).optional(),
  compactProgress: z.record(z.string(), CompactProgressSchema.optional()).optional(),
  permissions: z.record(z.string(), z.array(PermissionRequestSchema)).optional(),
  questions: z.record(z.string(), z.array(QuestionRequestSchema)).optional(),
  messages: z.array(MessagePatchSchema).optional(),
})

export const WebSocketFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), state: WebStateSnapshotSchema }),
  z.object({ type: z.literal("patch"), patch: WebStatePatchSchema }),
])

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type CompactProgressSegment = z.infer<typeof CompactProgressSegmentSchema>
export type CompactProgress = z.infer<typeof CompactProgressSchema>
export type WebStateSnapshot = z.infer<typeof WebStateSnapshotSchema>
export type MessagePatch = z.infer<typeof MessagePatchSchema>
export type WebStatePatch = z.infer<typeof WebStatePatchSchema>
export type WebSocketFrame = z.infer<typeof WebSocketFrameSchema>

import { SessionIdSchema } from "@wren/protocol"
import { z } from "zod"

export const CreateSessionPayloadSchema = z.object({
  cwd: z.string().min(1),
  modelId: z.string().min(1).default("fixture/sonnet"),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk"]).default("default"),
})

export const PromptPayloadSchema = z.object({
  prompt: z.string().min(1),
})

export const PermissionReplyPayloadSchema = z.object({
  response: z.enum(["once", "session", "deny"]),
})

export const SessionRouteParamsSchema = z.object({
  sessionId: SessionIdSchema,
})

export type CreateSessionPayload = z.infer<typeof CreateSessionPayloadSchema>
export type PromptPayload = z.infer<typeof PromptPayloadSchema>
export type PermissionReplyPayload = z.infer<typeof PermissionReplyPayloadSchema>

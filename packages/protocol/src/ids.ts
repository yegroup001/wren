import { z } from "zod"

export const SessionIdSchema = z.string().min(1).brand("SessionId")
export const MessageIdSchema = z.string().min(1).brand("MessageId")
export const PartIdSchema = z.string().min(1).brand("PartId")
export const PermissionIdSchema = z.string().min(1).brand("PermissionId")
export const RequestIdSchema = z.string().min(1).brand("RequestId")

export type SessionId = z.infer<typeof SessionIdSchema>
export type MessageId = z.infer<typeof MessageIdSchema>
export type PartId = z.infer<typeof PartIdSchema>
export type PermissionId = z.infer<typeof PermissionIdSchema>
export type RequestId = z.infer<typeof RequestIdSchema>

export function parseSessionId(value: string): SessionId {
  return SessionIdSchema.parse(value)
}

export function parseMessageId(value: string): MessageId {
  return MessageIdSchema.parse(value)
}

export function parsePartId(value: string): PartId {
  return PartIdSchema.parse(value)
}

export function parsePermissionId(value: string): PermissionId {
  return PermissionIdSchema.parse(value)
}

export function parseRequestId(value: string): RequestId {
  return RequestIdSchema.parse(value)
}

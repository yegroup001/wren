import type { RequestId } from "@wren/protocol"

export type { RequestId }

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

// ---------------------------------------------------------------------------
// Application snapshot — the bootstrap/resync payload
// ---------------------------------------------------------------------------

export interface ApplicationSnapshot {
  readonly protocolVersion: ProtocolVersion
  readonly applicationEpoch: string
  readonly cursor: number
  readonly workspaceId: string
  readonly workspaceLabel: string
  readonly sessions: readonly SessionSummaryView[]
}

// ---------------------------------------------------------------------------
// Session summary view
// ---------------------------------------------------------------------------

export interface SessionSummaryView {
  readonly sessionId: string
  readonly revision: number
  readonly title: string
  readonly modelId: string
  readonly permissionMode: string
  readonly effort: string | undefined
  readonly preview: string
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Command/result/error (stub — will be expanded in Step 4)
// ---------------------------------------------------------------------------

export type WrenCommand =
  | { type: "session.list" }
  | {
      type: "session.create"
      cwd: string
      modelId?: string
      permissionMode?: string
      effort?: string
    }
  | { type: "session.delete"; sessionId: string; expectedRevision?: number }
  | { type: "session.send"; sessionId: string; prompt: string; editMessageId?: string }
  | { type: "session.retry"; sessionId: string }

export interface WrenCommandResult {
  readonly ok: boolean
  readonly error?: WrenCommandError
  readonly cursor?: number
  readonly sessionRevision?: number
}

export interface WrenCommandError {
  readonly code: WrenCommandErrorCode
  readonly message: string
}

export type WrenCommandErrorCode =
  | "invalid_command"
  | "not_found"
  | "busy"
  | "conflict"
  | "request_id_conflict"
  | "epoch_mismatch"
  | "stale_cursor"
  | "protocol_incompatible"
  | "persistence_error"
  | "unsupported"
  | "internal"

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export interface WrenEventEnvelope {
  readonly protocolVersion: ProtocolVersion
  readonly applicationEpoch: string
  readonly cursor: number
  readonly batchId: string
  readonly batchIndex: number
  readonly batchSize: number
  readonly occurredAt: string
  readonly payload: WrenEventPayload
}

export type WrenEventPayload =
  | { type: "session.summary_upsert"; summary: SessionSummaryView }
  | { type: "session.summary_remove"; sessionId: string }

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export type WrenSubscriptionStart =
  | { ok: true; unsubscribe: () => Promise<void> }
  | { ok: false; reason: "stale_cursor" | "epoch_changed" | "protocol_incompatible" }

export type WrenSubscriptionItem =
  | { type: "event"; event: WrenEventEnvelope }
  | { type: "resyncRequired"; reason: "overflow" | "epoch_changed" }

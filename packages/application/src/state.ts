import type { WrenEngine } from "@wren/engine"
import type {
  Diff,
  Message,
  MessageId,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionId,
  SessionPreview,
  Status,
  Todo,
} from "@wren/protocol"

// ---------------------------------------------------------------------------
// SessionRuntimeView — the public runtime authority for one session
// ---------------------------------------------------------------------------

export type SessionPhase =
  | "idle"
  | "starting"
  | "streaming"
  | "waiting_permission"
  | "waiting_question"
  | "provider_retrying"
  | "compacting"
  | "finalizing"
  | "persistence_error"

export interface FailureView {
  readonly failureId: string
  readonly message: string
  readonly category: string
  readonly timestamp: string
  readonly canRetry: boolean
  readonly canRetryPersistence: boolean
}

export interface SessionRuntimeView {
  readonly phase: SessionPhase
  readonly activeRunId: string | undefined
  readonly activeTurnId: string | undefined
  readonly rootTurnId: string | undefined
  readonly queueDepth: number
  readonly canAbort: boolean
  readonly canRetry: boolean
  readonly canRetryPersistence: boolean
  readonly lastTerminalOutcome:
    | { runId: string; turnId: string; outcome: "succeeded" | "failed" | "aborted" | "yielded" }
    | undefined
  readonly failure: FailureView | undefined
}

// ---------------------------------------------------------------------------
// QueuedPromptView — transient queue entry
// ---------------------------------------------------------------------------

export interface QueuedPromptView {
  readonly queueId: string
  readonly requestId: string
  readonly reservedTurnId: string
  readonly text: string
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// SessionController — per-session runtime authority
// ---------------------------------------------------------------------------

export interface SessionController {
  readonly sessionId: SessionId
  readonly engine: WrenEngine
  runtime: SessionRuntimeView
  queuedPrompts: QueuedPromptView[]
  pendingPermissions: PermissionRequest[]
  pendingQuestions: QuestionRequest[]
  runningPrompt: Promise<void> | null
  aborted: boolean
  lastRunFailed: boolean
  pendingModelChange: string | null
  compactSavedQueuedMessages: Message[] | null
  // Engine session ID mapping (goal state is keyed by engine session ID)
  engineSessionId: string
  // User message → engine message count anchor for edit/resend
  userMessageEngineCounts: Map<MessageId, number>
}

// ---------------------------------------------------------------------------
// ApplicationState — plain internal state (no Solid, no UI)
// ---------------------------------------------------------------------------

export interface ApplicationState {
  readonly sessions: Map<SessionId, Session>
  readonly previews: Map<SessionId, SessionPreview>
  readonly messages: Map<SessionId, Message[]>
  readonly permissions: Map<SessionId, PermissionRequest[]>
  readonly questions: Map<SessionId, QuestionRequest[]>
  readonly todos: Map<SessionId, Todo[]>
  readonly diffs: Map<SessionId, Diff>
  readonly status: Map<SessionId, Status>
  readonly titles: Map<SessionId, string>
  readonly controllers: Map<SessionId, SessionController>
  readonly workspaceId: string
  readonly workspaceLabel: string
  readonly applicationEpoch: string
  cursor: number
}

export function createApplicationState(
  workspaceId: string,
  workspaceLabel: string,
): ApplicationState {
  return {
    sessions: new Map(),
    previews: new Map(),
    messages: new Map(),
    permissions: new Map(),
    questions: new Map(),
    todos: new Map(),
    diffs: new Map(),
    status: new Map(),
    titles: new Map(),
    controllers: new Map(),
    workspaceId,
    workspaceLabel,
    applicationEpoch: crypto.randomUUID(),
    cursor: 0,
  }
}

// ---------------------------------------------------------------------------
// Event journal — in-memory, bounded, per epoch
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  readonly cursor: number
  readonly batchId: string
  readonly batchIndex: number
  readonly batchSize: number
  readonly occurredAt: string
  readonly payload: unknown
}

export interface JournalEntry {
  readonly event: EventEnvelope
  batchComplete: boolean
}

export class EventJournal {
  private entries: JournalEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries
  }

  append(batch: EventEnvelope[]): void {
    if (batch.length === 0) return
    for (const event of batch) {
      this.entries.push({ event, batchComplete: false })
    }
    // Mark last entry of batch as batchComplete
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined) last.batchComplete = true
    // Trim old entries
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
  }

  getAfter(cursor: number): JournalEntry[] {
    return this.entries.filter((e) => e.event.cursor > cursor)
  }

  getCursor(): number {
    return this.entries.length > 0 ? (this.entries[this.entries.length - 1]?.event.cursor ?? 0) : 0
  }

  clear(): void {
    this.entries = []
  }
}

// ---------------------------------------------------------------------------
// Subscriber — bounded queue per client
// ---------------------------------------------------------------------------

export interface Subscriber {
  readonly id: string
  afterCursor: number
  queue: EventEnvelope[]
  readonly maxQueueSize: number
  overflow: boolean
  handler: (event: EventEnvelope) => void
}

export class SubscriberManager {
  private subscribers = new Map<string, Subscriber>()

  create(
    id: string,
    afterCursor: number,
    handler: (event: EventEnvelope) => void,
    maxQueueSize = 1000,
  ): Subscriber {
    const sub: Subscriber = {
      id,
      afterCursor,
      queue: [],
      maxQueueSize,
      overflow: false,
      handler,
    }
    this.subscribers.set(id, sub)
    return sub
  }

  publish(events: EventEnvelope[]): void {
    for (const sub of this.subscribers.values()) {
      if (sub.overflow) continue
      for (const event of events) {
        if (event.cursor <= sub.afterCursor) continue
        sub.queue.push(event)
        if (sub.queue.length > sub.maxQueueSize) {
          sub.overflow = true
          sub.queue.length = 0
          break
        }
      }
    }
    // Deliver to non-overflowed subscribers
    for (const sub of this.subscribers.values()) {
      if (sub.overflow) continue
      while (sub.queue.length > 0) {
        const event = sub.queue.shift()
        if (event === undefined) continue
        try {
          sub.handler(event)
        } catch {
          // Handler exception should not block other subscribers or the commit
        }
        sub.afterCursor = event.cursor
      }
    }
  }

  remove(id: string): void {
    this.subscribers.delete(id)
  }

  has(id: string): boolean {
    return this.subscribers.has(id)
  }
}

// ---------------------------------------------------------------------------
// Idempotency cache — (epoch, clientId, requestId) → cached result
// ---------------------------------------------------------------------------

export interface IdempotencyKey {
  readonly epoch: string
  readonly clientId: string
  readonly requestId: string
}

export interface IdempotencyEntry {
  readonly result: unknown
  readonly inFlight: Promise<unknown> | null
}

export class IdempotencyCache {
  private cache = new Map<string, IdempotencyEntry>()
  private readonly maxSize: number

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
  }

  private key(k: IdempotencyKey): string {
    return `${k.epoch}:${k.clientId}:${k.requestId}`
  }

  get(k: IdempotencyKey): IdempotencyEntry | undefined {
    return this.cache.get(this.key(k))
  }

  set(k: IdempotencyKey, entry: IdempotencyEntry): void {
    const keyStr = this.key(k)
    // Only evict when inserting a NEW key (not updating an existing one)
    if (!this.cache.has(keyStr) && this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(keyStr, entry)
  }

  has(k: IdempotencyKey): boolean {
    return this.cache.has(this.key(k))
  }
}

// ---------------------------------------------------------------------------
// Transaction draft — immutable patch prepared before commit
// ---------------------------------------------------------------------------

export interface TransactionDraft {
  readonly baseRevision: number | undefined
  readonly nextRevision: number | undefined
  readonly events: unknown[]
  readonly result: unknown
  readonly durableWrite: (() => Promise<void>) | null
}

// ---------------------------------------------------------------------------
// Default runtime view
// ---------------------------------------------------------------------------

export function defaultRuntimeView(): SessionRuntimeView {
  return {
    phase: "idle",
    activeRunId: undefined,
    activeTurnId: undefined,
    rootTurnId: undefined,
    queueDepth: 0,
    canAbort: false,
    canRetry: false,
    canRetryPersistence: false,
    lastTerminalOutcome: undefined,
    failure: undefined,
  }
}

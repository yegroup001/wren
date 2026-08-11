import type { WrenEngine, WrenEngineFactory } from "@wren/engine"
import type { SessionId } from "@wren/protocol"
import type { SessionStore } from "@wren/storage"
import {
  type ApplicationState,
  createApplicationState,
  defaultRuntimeView,
  type EventEnvelope,
  EventJournal,
  IdempotencyCache,
  type SessionController,
  SubscriberManager,
  type TransactionDraft,
} from "./state"

// ---------------------------------------------------------------------------
// SessionMutationLane — per-session FIFO serialization
// ---------------------------------------------------------------------------

export class SessionMutationLane {
  private chain: Promise<unknown> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    // Update the chain to catch errors so one failure doesn't break subsequent mutations
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

// ---------------------------------------------------------------------------
// WrenApplication — the sole authority for sessions
// ---------------------------------------------------------------------------

export interface WrenApplicationOptions {
  readonly sessionStore: SessionStore
  readonly engineFactory: WrenEngineFactory
  readonly workspaceId: string
  readonly workspaceLabel: string
}

export class WrenApplication {
  readonly state: ApplicationState
  readonly sessionStore: SessionStore
  readonly engineFactory: WrenEngineFactory
  readonly lanes = new Map<SessionId, SessionMutationLane>()
  private readonly commitMutex = new Mutex()
  readonly journal: EventJournal
  readonly subscribers: SubscriberManager
  readonly idempotency: IdempotencyCache

  constructor(options: WrenApplicationOptions) {
    this.sessionStore = options.sessionStore
    this.engineFactory = options.engineFactory
    this.state = createApplicationState(options.workspaceId, options.workspaceLabel)
    this.journal = new EventJournal()
    this.subscribers = new SubscriberManager()
    this.idempotency = new IdempotencyCache()
  }

  // -------------------------------------------------------------------------
  // Per-session mutation lane
  // -------------------------------------------------------------------------

  getLane(sessionId: SessionId): SessionMutationLane {
    let lane = this.lanes.get(sessionId)
    if (lane === undefined) {
      lane = new SessionMutationLane()
      this.lanes.set(sessionId, lane)
    }
    return lane
  }

  // -------------------------------------------------------------------------
  // Global commit — publishes events under the commit mutex
  // -------------------------------------------------------------------------

  async commit(draft: TransactionDraft): Promise<unknown> {
    return this.commitMutex.run(async () => {
      // Perform durable write first (if required)
      if (draft.durableWrite !== null) {
        await draft.durableWrite()
      }

      // Assign contiguous cursors to the batch
      const batchId = crypto.randomUUID()
      const batchSize = draft.events.length
      const baseCursor = this.state.cursor + 1
      const now = new Date().toISOString()

      const envelopes: EventEnvelope[] = draft.events.map((payload, i) => ({
        cursor: baseCursor + i,
        batchId,
        batchIndex: i,
        batchSize,
        occurredAt: now,
        payload,
      }))

      // Append to journal
      this.journal.append(envelopes)
      this.state.cursor = baseCursor + batchSize - 1

      // Publish to subscribers
      this.subscribers.publish(envelopes)

      return draft.result
    })
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  getController(sessionId: SessionId): SessionController | undefined {
    return this.state.controllers.get(sessionId)
  }

  getOrCreateController(sessionId: SessionId, engine: WrenEngine): SessionController {
    let controller = this.state.controllers.get(sessionId)
    if (controller === undefined) {
      controller = {
        sessionId,
        engine,
        runtime: defaultRuntimeView(),
        queuedPrompts: [],
        pendingPermissions: [],
        pendingQuestions: [],
        runningPrompt: null,
        aborted: false,
        lastRunFailed: false,
        pendingModelChange: null,
        compactSavedQueuedMessages: null,
        engineSessionId: sessionId as string,
        userMessageEngineCounts: new Map(),
      }
      this.state.controllers.set(sessionId, controller)
    }
    return controller
  }
}

// ---------------------------------------------------------------------------
// Mutex — simple async mutex for the global commit
// ---------------------------------------------------------------------------

class Mutex {
  private chain: Promise<unknown> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

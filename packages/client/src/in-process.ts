import type { EventEnvelope, WrenApplication } from "@wren/application"
import type { SnapshotOptions, WrenClient } from "./index"
import type {
  ApplicationSnapshot,
  RequestId,
  WrenCommand,
  WrenCommandResult,
  WrenEventEnvelope,
  WrenSubscriptionItem,
  WrenSubscriptionStart,
} from "./types"

// ---------------------------------------------------------------------------
// InProcessWrenClient — calls WrenApplication directly in-process.
//
// Lives at the @wren/client/in-process subpath so the main entry stays
// framework-neutral and browser-buildable; this transport pulls in
// @wren/application (and transitively engine/storage).
// ---------------------------------------------------------------------------

export class InProcessWrenClient implements WrenClient {
  private readonly app: WrenApplication
  private subscriptionCounter = 0
  private readonly subscriptionIds: string[] = []
  private readonly sessionCreatedAt = new Map<string, string>()

  constructor(app: WrenApplication) {
    this.app = app
  }

  async initialize(_options?: SnapshotOptions): Promise<ApplicationSnapshot> {
    return this.buildSnapshot()
  }

  async resync(_options?: SnapshotOptions): Promise<ApplicationSnapshot> {
    return this.buildSnapshot()
  }

  async execute(request: {
    requestId: RequestId
    command: WrenCommand
  }): Promise<WrenCommandResult> {
    const { command } = request

    // session.list is supported; the remaining commands await application-level
    // command slices (session CRUD + prompt dispatch live in the adapter layer
    // today). They return an explicit unsupported error rather than pretending.
    switch (command.type) {
      case "session.list":
        return { ok: true } as WrenCommandResult
      default:
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: `command "${command.type}" not supported by InProcessWrenClient yet`,
          },
        } as WrenCommandResult
    }
  }

  async subscribe(
    after: { applicationEpoch: string; cursor: number },
    handler: (item: WrenSubscriptionItem) => void,
  ): Promise<WrenSubscriptionStart> {
    // Check epoch
    if (after.applicationEpoch !== this.app.state.applicationEpoch) {
      return { ok: false, reason: "epoch_changed" }
    }

    const subId = `sub-${++this.subscriptionCounter}`
    this.subscriptionIds.push(subId)
    this.app.subscribers.create(subId, after.cursor, (event: EventEnvelope) => {
      // Bridge application EventEnvelope → client WrenEventEnvelope
      const clientEvent: WrenEventEnvelope = {
        protocolVersion: 1,
        applicationEpoch: this.app.state.applicationEpoch,
        cursor: event.cursor,
        batchId: event.batchId,
        batchIndex: event.batchIndex,
        batchSize: event.batchSize,
        occurredAt: event.occurredAt,
        payload: event.payload as WrenEventEnvelope["payload"],
      }
      handler({ type: "event", event: clientEvent })
    })

    return {
      ok: true,
      unsubscribe: async () => {
        this.app.subscribers.remove(subId)
      },
    }
  }

  async close(): Promise<void> {
    // Remove all active subscriptions
    for (const subId of this.subscriptionIds) {
      this.app.subscribers.remove(subId)
    }
    this.subscriptionIds.length = 0
  }

  // -------------------------------------------------------------------------

  private buildSnapshot(): ApplicationSnapshot {
    const snapshotTime = new Date().toISOString()
    const sessions = Array.from(this.app.state.sessions.values()).map((s) => {
      const messages = this.app.state.messages.get(s.id) ?? []
      const createdAt =
        this.sessionCreatedAt.get(s.id) ??
        messages[0]?.createdAt ??
        this.app.state.previews.get(s.id)?.createdAt ??
        snapshotTime
      this.sessionCreatedAt.set(s.id, createdAt)

      return {
        sessionId: s.id as string,
        revision: 0,
        title: "",
        modelId: s.modelId,
        permissionMode: s.permissionMode,
        effort: s.effort,
        preview: "",
        createdAt,
        updatedAt: messages[messages.length - 1]?.createdAt ?? createdAt,
      }
    })

    return {
      protocolVersion: 1,
      applicationEpoch: this.app.state.applicationEpoch,
      cursor: this.app.state.cursor,
      workspaceId: this.app.state.workspaceId,
      workspaceLabel: this.app.state.workspaceLabel,
      sessions,
    }
  }
}

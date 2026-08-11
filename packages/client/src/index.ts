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
// WrenClient — framework-neutral, browser-buildable client contract
// ---------------------------------------------------------------------------

export interface WrenClient {
  initialize(options?: SnapshotOptions): Promise<ApplicationSnapshot>
  resync(options?: SnapshotOptions): Promise<ApplicationSnapshot>
  execute(request: { requestId: RequestId; command: WrenCommand }): Promise<WrenCommandResult>
  subscribe(
    after: { applicationEpoch: string; cursor: number },
    handler: (item: WrenSubscriptionItem) => void,
  ): Promise<WrenSubscriptionStart>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// SnapshotOptions — controls which sessions include detail in the snapshot
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  readonly includeDetail?: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// ApplicationReplica — plain TypeScript replica of the application read model
// ---------------------------------------------------------------------------

export interface ApplicationReplica {
  readonly snapshot: ApplicationSnapshot
  readonly cursor: number
  readonly applicationEpoch: string
  readonly detailLoaded: ReadonlySet<string>
  applyEvent(event: WrenEventEnvelope): void
  isStale(): boolean
  resync(snapshot: ApplicationSnapshot): void
}

export function createApplicationReplica(snapshot: ApplicationSnapshot): ApplicationReplica {
  let current = snapshot
  let stale = false
  const detailLoaded = new Set<string>()

  return {
    get snapshot() {
      return current
    },
    get cursor() {
      return current.cursor ?? 0
    },
    get applicationEpoch() {
      return current.applicationEpoch ?? ""
    },
    get detailLoaded() {
      return detailLoaded
    },
    applyEvent(event: WrenEventEnvelope): void {
      if (event.applicationEpoch !== current.applicationEpoch) {
        stale = true
        return
      }
      if (event.cursor <= (current.cursor ?? 0)) {
        return // duplicate or stale event
      }
      let sessions = current.sessions
      if (event.payload.type === "session.summary_upsert") {
        const { summary } = event.payload
        const existing = sessions.findIndex((s) => s.sessionId === summary.sessionId)
        sessions =
          existing >= 0
            ? sessions.map((s, i) => (i === existing ? summary : s))
            : [...sessions, summary]
      } else if (event.payload.type === "session.summary_remove") {
        const { sessionId } = event.payload
        sessions = sessions.filter((s) => s.sessionId !== sessionId)
      }
      current = { ...current, cursor: event.cursor, sessions }
    },
    isStale(): boolean {
      return stale
    },
    resync(snapshot: ApplicationSnapshot): void {
      current = snapshot
      stale = false
    },
  }
}

// Re-export types
export * from "./types"

import type {
  ApplicationSnapshot,
  WrenClient,
  WrenEventEnvelope,
  WrenSubscriptionItem,
} from "@wren/client"
import { batch, createSignal } from "solid-js"

// ---------------------------------------------------------------------------
// ClientStore — TUI-local Solid binding for WrenClient
// ---------------------------------------------------------------------------

export interface ClientStore {
  readonly snapshot: () => ApplicationSnapshot
  readonly isStale: () => boolean
  readonly isLoading: () => boolean
  resync(): Promise<void>
  dispose(): void
}

export function createClientStore(client: WrenClient): ClientStore {
  const [snapshot, setSnapshot] = createSignal<ApplicationSnapshot | null>(null)
  const [stale, setStale] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  let disposed = false
  let currentUnsubscribe: (() => Promise<void>) | null = null
  let resyncInProgress = false
  let resyncPending = false

  async function subscribeToEvents(snap: ApplicationSnapshot): Promise<boolean> {
    // Unsubscribe from any previous subscription
    if (currentUnsubscribe !== null) {
      await currentUnsubscribe()
      currentUnsubscribe = null
    }

    const subStart = await client.subscribe(
      { applicationEpoch: snap.applicationEpoch, cursor: snap.cursor },
      (item: WrenSubscriptionItem) => {
        if (disposed) return
        if (item.type === "resyncRequired") {
          setStale(true)
          requestResync()
          return
        }
        batch(() => {
          const current = snapshot()
          if (current !== null && item.type === "event") {
            const event = item.event as WrenEventEnvelope
            if (event.applicationEpoch !== current.applicationEpoch) {
              setStale(true)
              requestResync()
              return
            }
            setSnapshot({
              ...current,
              cursor: event.cursor,
            })
          }
        })
      },
    )

    if (subStart.ok) {
      currentUnsubscribe = subStart.unsubscribe
      return true
    }

    // Subscription failed — need resync
    setStale(true)
    return false
  }

  async function init(): Promise<void> {
    const snap = await client.initialize()
    if (disposed) return
    setSnapshot(snap)

    const ok = await subscribeToEvents(snap)
    if (disposed) return
    if (ok) {
      setLoading(false)
    } else {
      requestResync()
    }
  }

  function requestResync(): void {
    if (disposed) return
    if (resyncInProgress) {
      resyncPending = true
      return
    }
    void resync().catch((error: unknown) => {
      if (!disposed) {
        console.error("[client-store] resync failed", error)
      }
    })
  }

  async function resync(): Promise<void> {
    if (disposed) return
    if (resyncInProgress) {
      resyncPending = true
      return
    }
    resyncInProgress = true
    setLoading(true)

    try {
      const snap = await client.resync()
      if (disposed) return
      setSnapshot(snap)
      setStale(false)

      // Re-subscribe with the new epoch and cursor
      const ok = await subscribeToEvents(snap)
      if (disposed) return
      if (!ok) {
        // Still can't subscribe — stay stale
        setStale(true)
      }
    } catch (error) {
      if (!disposed) {
        setStale(true)
      }
      throw error
    } finally {
      resyncInProgress = false
      if (!disposed) {
        setLoading(false)
      }
      if (resyncPending && !disposed) {
        resyncPending = false
        requestResync()
      }
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (currentUnsubscribe !== null) {
      void currentUnsubscribe()
      currentUnsubscribe = null
    }
    void client.close()
  }

  // Kick off initialization
  void init().catch((error: unknown) => {
    if (!disposed) {
      setStale(true)
      setLoading(false)
      console.error("[client-store] initialization failed", error)
    }
  })

  return {
    snapshot: () =>
      snapshot() ?? {
        protocolVersion: 1 as const,
        applicationEpoch: "",
        cursor: 0,
        workspaceId: "",
        workspaceLabel: "",
        sessions: [],
      },
    isStale: () => stale(),
    isLoading: () => loading(),
    resync,
    dispose,
  }
}

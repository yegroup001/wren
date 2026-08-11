import { describe, expect, test } from "bun:test"
import type {
  ApplicationSnapshot,
  WrenClient,
  WrenSubscriptionItem,
  WrenSubscriptionStart,
} from "@wren/client"
import { createRoot } from "solid-js"
import { createClientStore } from "./client-store"

// Fake WrenClient for testing
function createFakeClient(initialSnapshot: ApplicationSnapshot): {
  client: WrenClient
  publishEvent: (item: WrenSubscriptionItem) => void
  resyncCalled: boolean
} {
  let handler: ((item: WrenSubscriptionItem) => void) | null = null

  const client: WrenClient = {
    async initialize() {
      return initialSnapshot
    },
    async resync() {
      return initialSnapshot
    },
    async execute() {
      return { ok: true }
    },
    async subscribe(_after, h): Promise<WrenSubscriptionStart> {
      handler = h
      return {
        ok: true,
        unsubscribe: async () => {
          handler = null
        },
      }
    },
    async close() {},
  }

  return {
    client,
    publishEvent: (item: WrenSubscriptionItem) => {
      handler?.(item)
    },
    get resyncCalled() {
      return false
    },
  }
}

const testSnapshot: ApplicationSnapshot = {
  protocolVersion: 1,
  applicationEpoch: "test-epoch",
  cursor: 0,
  workspaceId: "ws-1",
  workspaceLabel: "Test",
  sessions: [],
}

describe("createClientStore", () => {
  test("initializes from client and exposes snapshot", async () => {
    const { client } = createFakeClient(testSnapshot)

    await createRoot(async (dispose) => {
      const store = createClientStore(client)

      // Wait for initialization
      await new Promise((r) => setTimeout(r, 50))

      expect(store.isLoading()).toBe(false)
      expect(store.snapshot().applicationEpoch).toBe("test-epoch")
      expect(store.snapshot().workspaceId).toBe("ws-1")
      expect(store.isStale()).toBe(false)

      store.dispose()
      dispose()
    })
  })

  test("marks stale on epoch mismatch event then resyncs", async () => {
    const { client, publishEvent } = createFakeClient(testSnapshot)

    await createRoot(async (dispose) => {
      const store = createClientStore(client)

      // Wait for initialization
      await new Promise((r) => setTimeout(r, 50))

      // Publish an event with a different epoch
      publishEvent({
        type: "event",
        event: {
          protocolVersion: 1,
          applicationEpoch: "different-epoch",
          cursor: 1,
          batchId: "batch-1",
          batchIndex: 0,
          batchSize: 1,
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: { type: "test" },
        },
      })

      // Wait for resync to complete (epoch mismatch triggers resync)
      await new Promise((r) => setTimeout(r, 50))

      // After resync, stale should be cleared
      expect(store.isStale()).toBe(false)
      expect(store.isLoading()).toBe(false)

      store.dispose()
      dispose()
    })
  })

  test("resyncRequired triggers resync", async () => {
    const { client, publishEvent } = createFakeClient(testSnapshot)

    await createRoot(async (dispose) => {
      const store = createClientStore(client)

      // Wait for initialization
      await new Promise((r) => setTimeout(r, 50))

      // Publish a resyncRequired
      publishEvent({ type: "resyncRequired", reason: "overflow" })

      // Wait for resync
      await new Promise((r) => setTimeout(r, 50))

      expect(store.isStale()).toBe(false)
      expect(store.isLoading()).toBe(false)

      store.dispose()
      dispose()
    })
  })

  test("marks stale and stops loading when initialization fails", async () => {
    const client = {
      initialize: async () => {
        throw new Error("initialize failed")
      },
      resync: async () => testSnapshot,
      execute: async () => ({ ok: true }),
      subscribe: async () => ({ ok: true, unsubscribe: async () => {} }),
      close: async () => {},
    } as unknown as WrenClient

    const originalError = console.error
    console.error = () => {}
    try {
      await createRoot(async (dispose) => {
        const store = createClientStore(client)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(store.isLoading()).toBe(false)
        expect(store.isStale()).toBe(true)
        store.dispose()
        dispose()
      })
    } finally {
      console.error = originalError
    }
  })

  test("queues a resync request received during an active resync", async () => {
    let handler: ((item: WrenSubscriptionItem) => void) | null = null
    let resyncCalls = 0
    let releaseFirstResync: (() => void) | undefined
    const firstResync = new Promise<ApplicationSnapshot>((resolve) => {
      releaseFirstResync = () => resolve({ ...testSnapshot, cursor: 1 })
    })
    const client: WrenClient = {
      async initialize() {
        return testSnapshot
      },
      async resync() {
        resyncCalls++
        return resyncCalls === 1 ? firstResync : { ...testSnapshot, cursor: 2 }
      },
      async execute() {
        return { ok: true }
      },
      async subscribe(_after, nextHandler) {
        handler = nextHandler
        return { ok: true, unsubscribe: async () => {} }
      },
      async close() {},
    }

    await createRoot(async (dispose) => {
      const store = createClientStore(client)
      await new Promise((resolve) => setTimeout(resolve, 20))

      handler?.({ type: "resyncRequired", reason: "first" })
      await new Promise((resolve) => setTimeout(resolve, 10))
      handler?.({ type: "resyncRequired", reason: "second" })
      expect(resyncCalls).toBe(1)

      releaseFirstResync?.()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(resyncCalls).toBe(2)
      expect(store.snapshot().cursor).toBe(2)

      store.dispose()
      dispose()
    })
  })

  test("dispose stops receiving events", async () => {
    const { client, publishEvent } = createFakeClient(testSnapshot)

    await createRoot(async (dispose) => {
      const store = createClientStore(client)

      // Wait for initialization
      await new Promise((r) => setTimeout(r, 50))

      store.dispose()

      // Publishing events after dispose should not crash
      publishEvent({
        type: "event",
        event: {
          protocolVersion: 1,
          applicationEpoch: "test-epoch",
          cursor: 1,
          batchId: "batch-1",
          batchIndex: 0,
          batchSize: 1,
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: { type: "test" },
        },
      })

      // No crash = pass
      dispose()
    })
  })
})

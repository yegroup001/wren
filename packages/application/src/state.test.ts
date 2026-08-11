import { describe, expect, test } from "bun:test"
import type { EventEnvelope } from "./state"
import {
  createApplicationState,
  defaultRuntimeView,
  EventJournal,
  IdempotencyCache,
  SubscriberManager,
} from "./state"

function makeEvent(cursor: number): EventEnvelope {
  return {
    cursor,
    batchId: "batch-1",
    batchIndex: 0,
    batchSize: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: { type: "test", cursor },
  }
}

describe("createApplicationState", () => {
  test("initializes with empty maps and a fresh epoch", () => {
    const state = createApplicationState("ws-1", "My Project")
    expect(state.workspaceId).toBe("ws-1")
    expect(state.workspaceLabel).toBe("My Project")
    expect(state.applicationEpoch).toBeTruthy()
    expect(state.cursor).toBe(0)
    expect(state.sessions.size).toBe(0)
    expect(state.messages.size).toBe(0)
  })

  test("each state has a unique epoch", () => {
    const s1 = createApplicationState("ws-1", "A")
    const s2 = createApplicationState("ws-1", "A")
    expect(s1.applicationEpoch).not.toBe(s2.applicationEpoch)
  })
})

describe("defaultRuntimeView", () => {
  test("starts idle with no active run", () => {
    const view = defaultRuntimeView()
    expect(view.phase).toBe("idle")
    expect(view.activeRunId).toBeUndefined()
    expect(view.canAbort).toBe(false)
    expect(view.canRetry).toBe(false)
    expect(view.failure).toBeUndefined()
    expect(view.queueDepth).toBe(0)
  })
})

describe("EventJournal", () => {
  test("appends events with contiguous cursors", () => {
    const journal = new EventJournal()
    journal.append([makeEvent(1), makeEvent(2), makeEvent(3)])
    expect(journal.getCursor()).toBe(3)
    expect(journal.getAfter(0)).toHaveLength(3)
    expect(journal.getAfter(1)).toHaveLength(2)
  })

  test("marks last entry of each batch as batchComplete", () => {
    const journal = new EventJournal()
    journal.append([makeEvent(1), makeEvent(2)])
    const entries = journal.getAfter(0)
    expect(entries[0]?.batchComplete).toBe(false)
    expect(entries[1]?.batchComplete).toBe(true)
  })

  test("trims old entries when exceeding max", () => {
    const journal = new EventJournal(5)
    for (let i = 1; i <= 10; i++) {
      journal.append([makeEvent(i)])
    }
    expect(journal.getAfter(0)).toHaveLength(5)
    expect(journal.getCursor()).toBe(10)
  })

  test("clear removes all entries", () => {
    const journal = new EventJournal()
    journal.append([makeEvent(1)])
    journal.clear()
    expect(journal.getAfter(0)).toHaveLength(0)
  })
})

describe("SubscriberManager", () => {
  test("creates and delivers events to subscribers", () => {
    const mgr = new SubscriberManager()
    const received: EventEnvelope[] = []
    mgr.create("sub-1", 0, (event) => received.push(event))

    mgr.publish([makeEvent(1), makeEvent(2)])
    expect(received).toHaveLength(2)
    expect(received[0]?.cursor).toBe(1)
    expect(received[1]?.cursor).toBe(2)
  })

  test("skips events at or before afterCursor", () => {
    const mgr = new SubscriberManager()
    const received: EventEnvelope[] = []
    mgr.create("sub-1", 5, (event) => received.push(event))

    mgr.publish([makeEvent(3), makeEvent(5), makeEvent(6), makeEvent(7)])
    expect(received).toHaveLength(2)
    expect(received[0]?.cursor).toBe(6)
  })

  test("overflow sets flag and stops delivery", () => {
    const mgr = new SubscriberManager()
    const received: EventEnvelope[] = []
    mgr.create("sub-1", 0, (event) => received.push(event), 2)

    // Publish more events than the queue can hold
    mgr.publish([makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)])
    // After overflow, no more events should be delivered
    expect(received).toHaveLength(0) // overflow clears the queue
  })

  test("remove stops delivery", () => {
    const mgr = new SubscriberManager()
    const received: EventEnvelope[] = []
    mgr.create("sub-1", 0, (event) => received.push(event))
    mgr.remove("sub-1")

    mgr.publish([makeEvent(1)])
    expect(received).toHaveLength(0)
  })
})

describe("IdempotencyCache", () => {
  test("stores and retrieves by epoch:clientId:requestId", () => {
    const cache = new IdempotencyCache()
    const key = { epoch: "e1", clientId: "c1", requestId: "r1" }
    cache.set(key, { result: { ok: true }, inFlight: null })

    const entry = cache.get(key)
    expect(entry).toBeDefined()
    expect(entry?.result).toEqual({ ok: true })
  })

  test("has returns true for existing keys", () => {
    const cache = new IdempotencyCache()
    const key = { epoch: "e1", clientId: "c1", requestId: "r1" }
    expect(cache.has(key)).toBe(false)
    cache.set(key, { result: null, inFlight: null })
    expect(cache.has(key)).toBe(true)
  })

  test("evicts oldest entry when maxSize exceeded", () => {
    const cache = new IdempotencyCache(2)
    cache.set({ epoch: "e", clientId: "c", requestId: "r1" }, { result: 1, inFlight: null })
    cache.set({ epoch: "e", clientId: "c", requestId: "r2" }, { result: 2, inFlight: null })
    cache.set({ epoch: "e", clientId: "c", requestId: "r3" }, { result: 3, inFlight: null })

    expect(cache.has({ epoch: "e", clientId: "c", requestId: "r1" })).toBe(false)
    expect(cache.has({ epoch: "e", clientId: "c", requestId: "r2" })).toBe(true)
    expect(cache.has({ epoch: "e", clientId: "c", requestId: "r3" })).toBe(true)
  })
})

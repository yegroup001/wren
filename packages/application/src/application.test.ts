import { describe, expect, test } from "bun:test"
import { SessionMutationLane, WrenApplication } from "./application"
import type { EventEnvelope, TransactionDraft } from "./state"

// Minimal stubs for dependencies
function createMockStore() {
  return {
    save: async () => {},
    load: async () => ({ skipped: [], summaries: [] }),
    listSummaries: async () => ({ skipped: [], summaries: [] }),
    saveSessionMeta: async () => {},
    delete: async () => {},
  } as Record<string, unknown>
}

function createMockEngineFactory() {
  return {
    createEngine: () =>
      ({
        submitMessage: async function* () {},
        interrupt: () => {},
        resetAbortController: () => {},
        getModel: () => "fake/model",
        setModel: () => {},
        setPermissionResolver: () => {},
        setPermissionMode: () => {},
        setPermissionModeChangeCallback: () => {},
        getMessages: () => [],
        truncateMessages: () => {},
        snapshotHistory: () => ({ restoreFor: () => {} }),
        restoreHistory: () => {},
        dispose: () => {},
      }) as Record<string, unknown>,
    getDefaultModel: () => "fake/model",
    getCommands: () => [],
    getAgents: () => [],
  } as Record<string, unknown>
}

describe("WrenApplication", () => {
  test("initializes with correct workspace and epoch", () => {
    const app = new WrenApplication({
      sessionStore: createMockStore(),
      engineFactory: createMockEngineFactory(),
      workspaceId: "ws-1",
      workspaceLabel: "My Project",
    })

    expect(app.state.workspaceId).toBe("ws-1")
    expect(app.state.workspaceLabel).toBe("My Project")
    expect(app.state.applicationEpoch).toBeTruthy()
    expect(app.state.cursor).toBe(0)
  })

  test("getLane returns the same lane for the same session", () => {
    const app = new WrenApplication({
      sessionStore: createMockStore(),
      engineFactory: createMockEngineFactory(),
      workspaceId: "ws-1",
      workspaceLabel: "Test",
    })

    const sessionId = "ses_test" as unknown as { toString(): string }
    const lane1 = app.getLane(sessionId)
    const lane2 = app.getLane(sessionId)
    expect(lane1).toBe(lane2)
  })

  test("commit assigns contiguous cursors and publishes events", async () => {
    const app = new WrenApplication({
      sessionStore: createMockStore(),
      engineFactory: createMockEngineFactory(),
      workspaceId: "ws-1",
      workspaceLabel: "Test",
    })

    const received: EventEnvelope[] = []
    app.subscribers.create("sub-1", 0, (e) => received.push(e))

    const draft: TransactionDraft = {
      baseRevision: undefined,
      nextRevision: undefined,
      events: [{ type: "test1" }, { type: "test2" }],
      result: { ok: true },
      durableWrite: null,
    }

    const result = await app.commit(draft)
    expect(result).toEqual({ ok: true })
    expect(app.state.cursor).toBe(2)
    expect(received).toHaveLength(2)
    expect(received[0]?.cursor).toBe(1)
    expect(received[1]?.cursor).toBe(2)
    expect(received[0]?.batchId).toBe(received[1]?.batchId)
    expect(received[0]?.batchIndex).toBe(0)
    expect(received[1]?.batchIndex).toBe(1)
    expect(received[1]?.batchSize).toBe(2)
  })

  test("commit with durableWrite calls it before publishing", async () => {
    const app = new WrenApplication({
      sessionStore: createMockStore(),
      engineFactory: createMockEngineFactory(),
      workspaceId: "ws-1",
      workspaceLabel: "Test",
    })

    let writeCalled = false
    const draft: TransactionDraft = {
      baseRevision: undefined,
      nextRevision: undefined,
      events: [{ type: "test" }],
      result: { ok: true },
      durableWrite: async () => {
        writeCalled = true
      },
    }

    await app.commit(draft)
    expect(writeCalled).toBe(true)
  })

  test("multiple commits get contiguous cursors", async () => {
    const app = new WrenApplication({
      sessionStore: createMockStore(),
      engineFactory: createMockEngineFactory(),
      workspaceId: "ws-1",
      workspaceLabel: "Test",
    })

    await app.commit({
      baseRevision: 0,
      nextRevision: 1,
      events: [{ type: "a" }],
      result: null,
      durableWrite: null,
    })
    await app.commit({
      baseRevision: 1,
      nextRevision: 2,
      events: [{ type: "b" }],
      result: null,
      durableWrite: null,
    })
    await app.commit({
      baseRevision: 2,
      nextRevision: 3,
      events: [{ type: "c" }],
      result: null,
      durableWrite: null,
    })

    expect(app.state.cursor).toBe(3)
    expect(app.journal.getAfter(0)).toHaveLength(3)
  })
})

describe("SessionMutationLane", () => {
  test("serializes mutations in FIFO order", async () => {
    const lane = new SessionMutationLane()
    const order: number[] = []

    const p1 = lane.run(async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
    })
    const p2 = lane.run(async () => {
      order.push(2)
    })
    const p3 = lane.run(async () => {
      order.push(3)
    })

    await Promise.all([p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  test("one failure does not break subsequent mutations", async () => {
    const lane = new SessionMutationLane()
    const order: string[] = []

    const p1 = lane
      .run(async () => {
        order.push("start-1")
        throw new Error("fail")
      })
      .catch(() => {
        order.push("caught-1")
      })
    const p2 = lane.run(async () => {
      order.push("start-2")
    })

    await Promise.all([p1, p2])
    expect(order).toContain("start-2")
  })
})

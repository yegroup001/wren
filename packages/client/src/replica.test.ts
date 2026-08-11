import { describe, expect, test } from "bun:test"
import { createApplicationReplica } from "./index"
import type { ApplicationSnapshot, WrenEventEnvelope } from "./types"

const baseSnapshot: ApplicationSnapshot = {
  protocolVersion: 1,
  applicationEpoch: "epoch-1",
  cursor: 5,
  workspaceId: "/tmp/w",
  workspaceLabel: "w",
  sessions: [
    {
      sessionId: "s1",
      revision: 1,
      title: "First",
      modelId: "m",
      permissionMode: "default",
      effort: undefined,
      preview: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
}

function event(payload: WrenEventEnvelope["payload"], cursor: number): WrenEventEnvelope {
  return {
    protocolVersion: 1,
    applicationEpoch: "epoch-1",
    cursor,
    batchId: "b",
    batchIndex: 0,
    batchSize: 1,
    occurredAt: "2026-01-01T00:00:01.000Z",
    payload,
  }
}

describe("createApplicationReplica", () => {
  test("upsert adds a new session summary", () => {
    const replica = createApplicationReplica(baseSnapshot)
    replica.applyEvent(
      event(
        {
          type: "session.summary_upsert",
          summary: {
            sessionId: "s2",
            revision: 1,
            title: "Second",
            modelId: "m",
            permissionMode: "default",
            effort: undefined,
            preview: "",
            createdAt: "2026-01-01T00:00:02.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        },
        6,
      ),
    )
    expect(replica.snapshot.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"])
    expect(replica.cursor).toBe(6)
  })

  test("upsert replaces an existing session summary", () => {
    const first = baseSnapshot.sessions[0]
    expect(first).toBeDefined()
    const replica = createApplicationReplica(baseSnapshot)
    replica.applyEvent(
      event(
        {
          type: "session.summary_upsert",
          summary: { ...first, title: "Renamed", revision: 2 },
        },
        6,
      ),
    )
    expect(replica.snapshot.sessions).toHaveLength(1)
    expect(replica.snapshot.sessions[0]?.title).toBe("Renamed")
    expect(replica.snapshot.sessions[0]?.revision).toBe(2)
  })

  test("remove drops a session summary", () => {
    const replica = createApplicationReplica(baseSnapshot)
    replica.applyEvent(event({ type: "session.summary_remove", sessionId: "s1" }, 6))
    expect(replica.snapshot.sessions).toHaveLength(0)
  })

  test("ignores duplicate and stale cursors", () => {
    const replica = createApplicationReplica(baseSnapshot)
    replica.applyEvent(event({ type: "session.summary_remove", sessionId: "s1" }, 5))
    expect(replica.snapshot.sessions).toHaveLength(1)
    expect(replica.isStale()).toBe(false)
  })

  test("marks stale on epoch mismatch", () => {
    const replica = createApplicationReplica(baseSnapshot)
    replica.applyEvent({
      ...event({ type: "session.summary_remove", sessionId: "s1" }, 6),
      applicationEpoch: "epoch-2",
    })
    expect(replica.isStale()).toBe(true)
    expect(replica.snapshot.sessions).toHaveLength(1)
  })

  test("resync restores snapshot and clears stale", () => {
    const replica = createApplicationReplica(baseSnapshot)
    replica.applyEvent({
      ...event({ type: "session.summary_remove", sessionId: "s1" }, 6),
      applicationEpoch: "epoch-2",
    })
    expect(replica.isStale()).toBe(true)
    replica.resync({ ...baseSnapshot, applicationEpoch: "epoch-2", cursor: 6 })
    expect(replica.isStale()).toBe(false)
    expect(replica.applicationEpoch).toBe("epoch-2")
  })
})

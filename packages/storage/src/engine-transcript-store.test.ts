import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEngineTranscriptStore } from "./engine-transcript-store"

describe("engine transcript store", () => {
  test("appends ordered main-stream events and reads them back", async () => {
    const store = createEngineTranscriptStore(":memory:")
    const events = await store.append("session-1", "/workspace", { sessionId: "session-1" }, [
      {
        type: "user",
        timestamp: "2026-07-23T00:00:00.000Z",
        messageUuid: "msg-1",
        payload: { type: "user", uuid: "msg-1" },
      },
      { type: "custom-title", payload: { customTitle: "SQLite migration" } },
    ])

    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    expect(await store.hasMessage("session-1", "msg-1")).toBe(true)
    expect(store.sessionExists("session-1")).toBe(true)
    expect(store.sessionExists("missing-session")).toBe(false)
    // messageUuids returns only message-bearing events (metadata excluded)
    const uuids = await store.messageUuids("session-1")
    expect(uuids).toEqual(["msg-1"])
    const read = await store.events("session-1")
    expect(read).toHaveLength(2)
    expect(read[0]).toMatchObject({
      type: "user",
      messageUuid: "msg-1",
      timestamp: "2026-07-23T00:00:00.000Z",
    })
    store.close()
  })

  test("keeps sidechain agent messages in their own stream", async () => {
    const store = createEngineTranscriptStore(":memory:")
    await store.append("session-1", "/workspace", { sessionId: "session-1" }, [
      { type: "user", messageUuid: "main-1", payload: { type: "user" } },
    ])
    const agent = { sessionId: "session-1", agentId: "agent-1", isSidechain: true }
    await store.append("session-1", "/workspace", agent, [
      { type: "assistant", messageUuid: "agent-1", payload: { type: "assistant" } },
    ])

    expect((await store.events("session-1", agent)).map((event) => event.messageUuid)).toEqual([
      "agent-1",
    ])
    expect((await store.events("session-1")).map((event) => event.messageUuid)).toEqual([
      "main-1",
      "agent-1",
    ])
    store.close()
  })

  test("rejects duplicate message UUIDs atomically", async () => {
    const store = createEngineTranscriptStore(":memory:")
    await store.append("session-1", "/workspace", { sessionId: "session-1" }, [
      { type: "user", messageUuid: "msg-1", payload: { type: "user" } },
    ])
    // The mirror (mirrorEntryToSqlite) gates on hasMessage before appending,
    // but the DB-level unique index is the race-safe guard. A raw duplicate
    // append must fail and roll back the entire batch.
    await expect(
      store.append("session-1", "/workspace", { sessionId: "session-1" }, [
        { type: "user", messageUuid: "msg-1", payload: { type: "user" } },
      ]),
    ).rejects.toThrow()
    expect(await store.events("session-1")).toHaveLength(1)
    store.close()
  })

  test("persists and updates subagent metadata", async () => {
    const store = createEngineTranscriptStore(":memory:")
    await store.append("session-1", "/workspace", { sessionId: "session-1" }, [
      { type: "user", messageUuid: "main-1", payload: { type: "user" } },
    ])
    await store.saveAgentMeta("session-1", {
      agentId: "agent-1",
      sessionId: "session-1",
      agentType: "explore",
      worktreePath: "/workspace-wt",
      description: "find the bug",
    })
    expect(await store.agentMeta("agent-1")).toEqual({
      agentId: "agent-1",
      sessionId: "session-1",
      agentType: "explore",
      worktreePath: "/workspace-wt",
      description: "find the bug",
    })
    expect(await store.agentMeta("missing-agent")).toBeUndefined()

    await store.saveAgentMeta("session-1", {
      agentId: "agent-1",
      sessionId: "session-1",
      agentType: "explore",
    })
    expect(await store.agentMeta("agent-1")).toEqual({
      agentId: "agent-1",
      sessionId: "session-1",
      agentType: "explore",
    })
    store.close()
  })

  test("sessionExists survives close/reopen on a file-backed store", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "engine-store-persist-test-"))
    const dbPath = join(tempDir, "engine.db")
    const store = createEngineTranscriptStore(dbPath)
    await store.append("persisted-session", "/workspace", { sessionId: "persisted-session" }, [
      { type: "user", messageUuid: "persisted-message", payload: { type: "user" } },
    ])
    store.close()

    const reopened = createEngineTranscriptStore(dbPath)
    expect(reopened.sessionExists("persisted-session")).toBe(true)
    expect((await reopened.events("persisted-session")).map((e) => e.messageUuid)).toEqual([
      "persisted-message",
    ])
    reopened.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  test("deleteSession removes session, events, and agent meta", async () => {
    const store = createEngineTranscriptStore(":memory:")
    await store.append("session-1", "/workspace", { sessionId: "session-1" }, [
      { type: "user", messageUuid: "msg-1", payload: { type: "user" } },
    ])
    await store.saveAgentMeta("session-1", {
      agentId: "agent-1",
      sessionId: "session-1",
      agentType: "explore",
      description: "find the bug",
    })

    expect(store.sessionExists("session-1")).toBe(true)
    expect((await store.events("session-1")).length).toBe(1)
    expect((await store.agentMeta("agent-1"))?.agentType).toBe("explore")

    store.deleteSession("session-1")

    expect(store.sessionExists("session-1")).toBe(false)
    expect((await store.events("session-1")).length).toBe(0)
    expect(await store.agentMeta("agent-1")).toBeUndefined()
    store.close()
  })

  test("sessionsTouchedSince returns sessions updated after the given instant", async () => {
    const store = createEngineTranscriptStore(":memory:")
    const cutoff = new Date(Date.now() - 60_000).toISOString()
    await store.append("session-old", "/workspace", { sessionId: "session-old" }, [
      { type: "user", messageUuid: "old-1", payload: { type: "user" } },
    ])
    await store.append("session-recent", "/workspace", { sessionId: "session-recent" }, [
      { type: "user", messageUuid: "recent-1", payload: { type: "user" } },
    ])

    // Both sessions were just created — everything is "recent".
    expect(store.sessionsTouchedSince("/workspace", cutoff)).toEqual(
      expect.arrayContaining(["session-old", "session-recent"]),
    )
    // A future cutoff returns nothing.
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(store.sessionsTouchedSince("/workspace", future)).toEqual([])
    // Other project paths are not included.
    expect(store.sessionsTouchedSince("/elsewhere", "1970-01-01T00:00:00.000Z")).toEqual([])
    store.close()
  })

  test("partial unique index prevents duplicate main streams", () => {
    const { initDatabase } = require("./db")
    const db = initDatabase(":memory:")
    db.run(
      "INSERT INTO engine_session (id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ["ses-1", "/tmp", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    )
    db.run(
      "INSERT INTO engine_stream (id, session_id, agent_id, is_sidechain, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)",
      ["stream-1", "ses-1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    )
    expect(() =>
      db.run(
        "INSERT INTO engine_stream (id, session_id, agent_id, is_sidechain, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)",
        ["stream-2", "ses-1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
      ),
    ).toThrow()
    // Distinct non-NULL agent IDs for the same session are allowed.
    db.run(
      "INSERT INTO engine_stream (id, session_id, agent_id, is_sidechain, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      ["stream-3", "ses-1", "agent-1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    )
    db.close()
  })
})

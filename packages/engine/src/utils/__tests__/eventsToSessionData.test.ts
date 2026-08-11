import { afterEach, describe, expect, test } from "bun:test"
import type { UUID } from "node:crypto"
import {
  closeTranscriptMirror,
  getTranscriptStore,
  initTranscriptMirror,
} from "../../storage/transcriptMirror.js"
import type { Entry } from "../../types/logs.js"
import {
  eventsToSessionData,
  mirrorEntryToSqlite,
  setEntryMirror,
  setTranscriptFileSink,
} from "../sessionStorage.js"

afterEach(() => {
  setEntryMirror(undefined)
  setTranscriptFileSink(null)
  closeTranscriptMirror()
})

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const sessionId = "session-events-to-data-test"
const u = (id: string): UUID => id as UUID

async function mirrorAndCollect(): Promise<ReturnType<typeof eventsToSessionData>> {
  initTranscriptMirror(":memory:")
  setEntryMirror(mirrorEntryToSqlite)

  mirrorEntryToSqlite(
    {
      type: "user",
      uuid: "user-1",
      parentUuid: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { role: "user", content: "first" },
    } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  mirrorEntryToSqlite(
    {
      type: "assistant",
      uuid: "assistant-1",
      parentUuid: "user-1",
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  mirrorEntryToSqlite(
    { type: "custom-title", sessionId, customTitle: "My title" } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  mirrorEntryToSqlite(
    {
      type: "goal",
      sessionId,
      state: { status: "active", objective: "finish" },
    } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  // Subagent sidechain entry must be excluded from the main session data.
  mirrorEntryToSqlite(
    {
      type: "user",
      uuid: "agent-user-1",
      parentUuid: "user-1",
      agentId: "agent-x",
      isSidechain: true,
      timestamp: "2026-08-01T00:00:02.000Z",
      message: { role: "user", content: "agent task" },
    } as unknown as Entry,
    { sessionId, agentId: "agent-x", isSidechain: true, isCompaction: false },
  )
  await flushMicrotasks()

  // biome-ignore lint/style/noNonNullAssertion: mirror initialized above
  const store = getTranscriptStore()!
  return eventsToSessionData(await store.events(sessionId))
}

describe("eventsToSessionData", () => {
  test("rebuilds session data from mirrored engine_event rows", async () => {
    const data = await mirrorAndCollect()

    expect(data.messages.size).toBe(2)
    expect(data.messages.get(u("user-1"))?.type).toBe("user")
    expect(data.messages.get(u("assistant-1"))?.type).toBe("assistant")
    // Sidechain agent entry is excluded — it lives in its own stream.
    expect(data.messages.has(u("agent-user-1"))).toBe(false)

    expect(data.customTitles.get(u(sessionId))).toBe("My title")
    expect(data.goals.get(u(sessionId))).toMatchObject({ status: "active" })

    // Leaf = the assistant message (terminal user/assistant node).
    expect(data.leafUuids.has(u("assistant-1"))).toBe(true)
    expect(data.leafUuids.has(u("user-1"))).toBe(false)
  })

  test("returns empty maps for an empty event list", () => {
    const data = eventsToSessionData([])
    expect(data.messages.size).toBe(0)
    expect(data.leafUuids.size).toBe(0)
    expect(data.customTitles.size).toBe(0)
  })
})

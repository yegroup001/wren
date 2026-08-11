import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionId } from "../bootstrap/state.js"
import {
  getAgentTranscript,
  mirrorEntryToSqlite,
  reAppendSessionMetadata,
  saveCustomTitle,
  setEntryMirror,
  setSessionFileForTesting,
  setTranscriptFileSink,
} from "../utils/sessionStorage.js"
import { asAgentId } from "../types/ids.js"
import type { Entry } from "../types/logs.js"
import { closeTranscriptMirror, getTranscriptStore, initTranscriptMirror } from "./transcriptMirror.js"

afterEach(() => {
  setEntryMirror(undefined)
  setTranscriptFileSink(null)
  closeTranscriptMirror()
})

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const sessionId = "session-mirror-test"

test("mirrors message entries into engine_event with cross-process dedup", async () => {
  initTranscriptMirror(":memory:")
  setEntryMirror(mirrorEntryToSqlite)

  const messageEntry = {
    type: "user",
    uuid: "msg-1",
    parentUuid: null,
    timestamp: "2026-08-01T00:00:00.000Z",
    message: { content: [{ type: "text", text: "hello" }] },
  } as unknown as Entry

  mirrorEntryToSqlite(messageEntry, { sessionId, isSidechain: false, isCompaction: false })
  // Simulates a resumed process re-recording restored history.
  mirrorEntryToSqlite(messageEntry, { sessionId, isSidechain: false, isCompaction: false })
  await flushMicrotasks()

  const store = getTranscriptStore()!
  const events = await store.events(sessionId)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: "user",
    messageUuid: "msg-1",
    timestamp: "2026-08-01T00:00:00.000Z",
  })
  expect("parentUuid" in events[0]!).toBe(false)
  expect(await store.hasMessage(sessionId, "msg-1")).toBe(true)
})

test("mirrors metadata entries (custom-title, goal) into engine_event", async () => {
  initTranscriptMirror(":memory:")
  setEntryMirror(mirrorEntryToSqlite)

  mirrorEntryToSqlite(
    { type: "custom-title", sessionId, customTitle: "SQLite migration" } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  mirrorEntryToSqlite(
    { type: "goal", sessionId, state: { status: "active", objective: "finish" } } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  await flushMicrotasks()

  const store = getTranscriptStore()!
  const events = await store.events(sessionId)
  expect(events.filter((e) => e.type === "custom-title")).toHaveLength(1)
  expect(events.filter((e) => e.type === "goal")).toHaveLength(1)
})

test("keeps sidechain agent messages in their own stream", async () => {
  initTranscriptMirror(":memory:")
  setEntryMirror(mirrorEntryToSqlite)

  mirrorEntryToSqlite(
    {
      type: "user",
      uuid: "main-1",
      parentUuid: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { content: [] },
    } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  mirrorEntryToSqlite(
    {
      type: "assistant",
      uuid: "agent-1",
      parentUuid: "main-1",
      agentId: "agent-x",
      isSidechain: true,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { content: [{ type: "text", text: "agent reply" }] },
    } as unknown as Entry,
    { sessionId, agentId: "agent-x", isSidechain: true, isCompaction: false },
  )
  await flushMicrotasks()

  const store = getTranscriptStore()!
  const agentStream = { sessionId, agentId: "agent-x", isSidechain: true }
  expect((await store.events(sessionId, agentStream)).map((e) => e.messageUuid)).toEqual([
    "agent-1",
  ])
  expect((await store.events(sessionId)).map((e) => e.messageUuid)).toEqual(["main-1", "agent-1"])
})

test("getAgentTranscript reads the agent transcript from the store", async () => {
  initTranscriptMirror(":memory:")
  setEntryMirror(mirrorEntryToSqlite)
  const currentSessionId = getSessionId()

  mirrorEntryToSqlite(
    {
      type: "user",
      uuid: "root-1",
      parentUuid: null,
      timestamp: "2026-08-01T00:00:00.000Z",
      message: { content: [{ type: "text", text: "root" }] },
    } as unknown as Entry,
    { sessionId: currentSessionId, isSidechain: false, isCompaction: false },
  )
  mirrorEntryToSqlite(
    {
      type: "user",
      uuid: "agent-user-1",
      parentUuid: "root-1",
      agentId: "agent-a",
      isSidechain: true,
      timestamp: "2026-08-01T00:00:00.100Z",
      message: { content: [{ type: "text", text: "task" }] },
    } as unknown as Entry,
    { sessionId: currentSessionId, agentId: "agent-a", isSidechain: true, isCompaction: false },
  )
  mirrorEntryToSqlite(
    {
      type: "assistant",
      uuid: "agent-assistant-1",
      parentUuid: "agent-user-1",
      agentId: "agent-a",
      isSidechain: true,
      timestamp: "2026-08-01T00:00:01.000Z",
      message: { content: [{ type: "text", text: "done" }] },
    } as unknown as Entry,
    { sessionId: currentSessionId, agentId: "agent-a", isSidechain: true, isCompaction: false },
  )
  await flushMicrotasks()

  const result = await getAgentTranscript(asAgentId("agent-a"))
  expect(result).not.toBeNull()
  expect(result?.messages.map((m) => m.uuid)).toEqual(["agent-user-1", "agent-assistant-1"])
  expect(result?.messages.map((m) => m.type)).toEqual(["user", "assistant"])
})

test("appendEntryToFile-based writes (saveCustomTitle, reAppendSessionMetadata) mirror too", async () => {
  initTranscriptMirror(":memory:")
  setEntryMirror(mirrorEntryToSqlite)
  setTranscriptFileSink(async () => {})
  const sessionId = getSessionId()
  const filePath = join(tmpdir(), `mirror-reappend-${Date.now()}.jsonl`)
  writeFileSync(filePath, "")
  setSessionFileForTesting(filePath)

  await saveCustomTitle(sessionId as never, "My title")
  await flushMicrotasks()
  const store = getTranscriptStore()!
  expect((await store.events(sessionId)).filter((e) => e.type === "custom-title")).toHaveLength(1)

  reAppendSessionMetadata()
  await flushMicrotasks()
  expect((await store.events(sessionId)).filter((e) => e.type === "custom-title")).toHaveLength(2)
})

test("mirror is a no-op before init and agent meta round-trips", async () => {
  setEntryMirror(mirrorEntryToSqlite)
  mirrorEntryToSqlite(
    { type: "custom-title", sessionId, customTitle: "dropped" } as unknown as Entry,
    { sessionId, isSidechain: false, isCompaction: false },
  )
  await flushMicrotasks()
  expect(getTranscriptStore()).toBeNull()

  initTranscriptMirror(":memory:")
  const store = getTranscriptStore()!
  await store.saveAgentMeta(sessionId, {
    agentId: "agent-meta-1",
    sessionId,
    agentType: "general-purpose",
    worktreePath: "/wt",
    description: "desc",
  })
  expect(await store.agentMeta("agent-meta-1")).toEqual({
    agentId: "agent-meta-1",
    sessionId,
    agentType: "general-purpose",
    worktreePath: "/wt",
    description: "desc",
  })
  closeTranscriptMirror()
  expect(getTranscriptStore()).toBeNull()
})

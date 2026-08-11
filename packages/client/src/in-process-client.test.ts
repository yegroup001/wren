import { describe, expect, spyOn, test } from "bun:test"
import { WrenApplication } from "@wren/application"
import type { Session, SessionId } from "@wren/protocol"
import { parseMessageId, parseSessionId } from "@wren/protocol"
import { InProcessWrenClient } from "./in-process"

function createTestApp(): WrenApplication {
  return new WrenApplication({
    sessionStore: {
      save: async () => {},
      load: async () => ({ ok: false }),
      listSummaries: async () => ({ skipped: [], summaries: [] }),
      saveSessionMeta: async () => {},
      delete: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any,
    engineFactory: {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      createEngine: () => Promise.resolve({} as any),
      getDefaultModel: () => "fake/model",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => "",
      dispose: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any,
    workspaceId: "/tmp/test",
    workspaceLabel: "Test",
  })
}

function createTestSession(app: WrenApplication, id: string): SessionId {
  const sessionId = parseSessionId(id)
  const session: Session = {
    id: sessionId,
    cwd: "/tmp/test",
    modelId: "fake/model",
    permissionMode: "default",
  }
  app.state.sessions.set(sessionId, session)
  app.state.messages.set(sessionId, [])
  app.state.status.set(sessionId, { type: "idle" })
  return sessionId
}

describe("InProcessWrenClient", () => {
  test("initialize returns a snapshot with workspace and epoch", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)

    const snapshot = await client.initialize()

    expect(snapshot.protocolVersion).toBe(1)
    expect(snapshot.applicationEpoch).toBe(app.state.applicationEpoch)
    expect(snapshot.workspaceId).toBe("/tmp/test")
    expect(snapshot.workspaceLabel).toBe("Test")
    expect(snapshot.cursor).toBe(0)
    expect(snapshot.sessions).toEqual([])
  })

  test("initialize returns sessions from ApplicationState", async () => {
    const app = createTestApp()
    createTestSession(app, "ses_a")
    createTestSession(app, "ses_b")
    const client = new InProcessWrenClient(app)

    const snapshot = await client.initialize()

    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.sessions[0]?.sessionId).toBe("ses_a")
    expect(snapshot.sessions[1]?.sessionId).toBe("ses_b")
  })

  test("resync preserves session timestamps from application state", async () => {
    const app = createTestApp()
    const sessionId = createTestSession(app, "ses_x")
    const createdAt = "2026-07-23T08:00:00.000Z"
    const updatedAt = "2026-07-23T09:00:00.000Z"
    app.state.messages.set(sessionId, [
      {
        id: parseMessageId("msg_first"),
        sessionId,
        role: "user",
        parts: [],
        createdAt,
      },
      {
        id: parseMessageId("msg_last"),
        sessionId,
        role: "assistant",
        parts: [],
        createdAt: updatedAt,
      },
    ])
    const client = new InProcessWrenClient(app)

    const init = await client.initialize()
    const resync = await client.resync()

    expect(init.sessions[0]?.createdAt).toBe(createdAt)
    expect(init.sessions[0]?.updatedAt).toBe(updatedAt)
    expect(resync.sessions).toEqual(init.sessions)
    expect(resync.applicationEpoch).toBe(init.applicationEpoch)
  })

  test("resync preserves first-seen timestamps for empty sessions", async () => {
    const firstSeenAt = "2026-07-23T08:00:00.000Z"
    const laterAt = "2026-07-23T09:00:00.000Z"
    const dateSpy = spyOn(Date.prototype, "toISOString").mockReturnValue(firstSeenAt)

    try {
      const app = createTestApp()
      createTestSession(app, "ses_empty")
      const client = new InProcessWrenClient(app)

      const init = await client.initialize()
      dateSpy.mockReturnValue(laterAt)
      const resync = await client.resync()

      expect(init.sessions[0]?.createdAt).toBe(firstSeenAt)
      expect(init.sessions[0]?.updatedAt).toBe(firstSeenAt)
      expect(resync.sessions).toEqual(init.sessions)
    } finally {
      dateSpy.mockRestore()
    }
  })

  test("subscribe with valid epoch returns ok", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)

    const snapshot = await client.initialize()
    const start = await client.subscribe(
      { applicationEpoch: snapshot.applicationEpoch, cursor: 0 },
      () => {},
    )

    expect(start.ok).toBe(true)
    if (start.ok) await start.unsubscribe()
  })

  test("subscribe with mismatched epoch returns false", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)

    const start = await client.subscribe({ applicationEpoch: "wrong-epoch", cursor: 0 }, () => {})

    expect(start.ok).toBe(false)
    if (!start.ok) expect(start.reason).toBe("epoch_changed")
  })

  test("execute session.list returns ok", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)

    const result = await client.execute({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      requestId: "req-1" as any,
      command: { type: "session.list" },
    })

    expect(result.ok).toBe(true)
  })

  test("execute unknown command returns error", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)

    const result = await client.execute({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      requestId: "req-2" as any,
      command: { type: "session.delete", sessionId: "ses_unknown" },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("unsupported")
  })

  test("subscriber receives events after subscribe", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)

    const snapshot = await client.initialize()
    const received: unknown[] = []

    const start = await client.subscribe(
      { applicationEpoch: snapshot.applicationEpoch, cursor: 0 },
      (item) => {
        if (item.type === "event") received.push(item.event)
      },
    )
    expect(start.ok).toBe(true)

    // Publish a test event through the application's commit
    await app.commit({
      baseRevision: undefined,
      nextRevision: undefined,
      events: [{ type: "test.event" }],
      result: null,
      durableWrite: null,
    })

    expect(received).toHaveLength(1)

    if (start.ok) await start.unsubscribe()
  })

  test("close is a no-op", async () => {
    const app = createTestApp()
    const client = new InProcessWrenClient(app)
    await client.close()
    // No throw = pass
  })
})

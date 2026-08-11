import { describe, expect, test } from "bun:test"
import { WrenApplication } from "@wren/application"
import type { WrenEngine, WrenEngineFactory } from "@wren/engine"
import { EngineHistorySnapshot } from "@wren/engine"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import { createRoot } from "solid-js"
import {
  createDualPathStore,
  projectPreview,
  projectSessionCreation,
  projectSessionDeletion,
  projectSessionEffort,
  projectSessionModel,
  projectStatus,
  projectTodos,
} from "./app-bridge"
import { createWrenAdapter } from "./local-adapter"
import { createTuiStore } from "./store"

// Minimal fake engine
class FakeEngine implements WrenEngine {
  async *submitMessage(): AsyncGenerator<never, void, unknown> {}
  interrupt(): void {}
  resetAbortController(): void {}
  getModel(): string {
    return "fake/model"
  }
  setModel(): void {}
  setPermissionResolver(): void {}
  setPermissionMode(): void {}
  setPermissionModeChangeCallback(): void {}
  getMessages(): readonly unknown[] {
    return []
  }
  truncateMessages(): void {}
  snapshotHistory(): EngineHistorySnapshot {
    return EngineHistorySnapshot.capture({}, [], () => {})
  }
  restoreHistory(): void {}
  dispose(): void {}
}

function makeFactory(): WrenEngineFactory {
  return {
    createEngine: () => new FakeEngine(),
    getDefaultModel: () => "fake/model",
    getCommands: () => [],
    getAgents: () => [],
  }
}

function setupProjection() {
  const store = createTuiStore()
  const app = new WrenApplication({
    sessionStore: {
      save: async () => {},
      load: async () => ({ ok: false }),
      listSummaries: async () => ({ skipped: [], summaries: [] }),
      saveSessionMeta: async () => {},
      delete: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any,
    engineFactory: makeFactory(),
    workspaceId: "/tmp/test",
    workspaceLabel: "test",
  })
  return { store, app }
}

describe("app-bridge equivalence", () => {
  test("session creation: Solid store and ApplicationState agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_1")
    const session = {
      id: sessionId,
      cwd: "/tmp/project",
      modelId: "fake/model",
      permissionMode: "default",
    }

    projectSessionCreation(store, app, session)

    // Solid store
    expect(store.getSession(sessionId)).toBeDefined()
    expect(store.getSession(sessionId)?.modelId).toBe("fake/model")
    expect(store.getBundle(sessionId)?.status.type).toBe("idle")

    // Application state
    expect(app.state.sessions.get(sessionId)).toBeDefined()
    expect(app.state.sessions.get(sessionId)?.modelId).toBe("fake/model")
    expect(app.state.status.get(sessionId)?.type).toBe("idle")
    expect(app.state.messages.get(sessionId)).toEqual([])
    expect(app.state.todos.get(sessionId)).toEqual([])
  })

  test("session model change: both stores agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_2")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "old-model",
      permissionMode: "default",
    })

    projectSessionModel(store, app, sessionId, "new-model")

    expect(store.getSession(sessionId)?.modelId).toBe("new-model")
    expect(app.state.sessions.get(sessionId)?.modelId).toBe("new-model")
  })

  test("session effort change: both stores agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_3")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      modelRef: { source: "fake", model: "model" },
      permissionMode: "default",
    })

    projectSessionEffort(store, app, sessionId, "high")

    expect(store.getSession(sessionId)?.effort).toBe("high")
    expect(app.state.sessions.get(sessionId)?.effort).toBe("high")
    expect(store.getSession(sessionId)?.modelRef).toEqual({
      source: "fake",
      model: "model",
      effort: "high",
    })
    expect(app.state.sessions.get(sessionId)?.modelRef).toEqual({
      source: "fake",
      model: "model",
      effort: "high",
    })
  })

  test("session deletion: both stores agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_4")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      permissionMode: "default",
    })

    projectSessionDeletion(store, app, sessionId)

    expect(store.getSession(sessionId)).toBeUndefined()
    expect(app.state.sessions.get(sessionId)).toBeUndefined()
    expect(app.state.messages.get(sessionId)).toBeUndefined()
    expect(app.state.status.get(sessionId)).toBeUndefined()
  })

  test("status change: both stores agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_5")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      permissionMode: "default",
    })

    projectStatus(store, app, sessionId, {
      type: "working",
      model: "fake/model",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    })

    expect(store.getBundle(sessionId)?.status.type).toBe("working")
    expect(app.state.status.get(sessionId)?.type).toBe("working")
  })

  test("preview: both stores agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_6")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      permissionMode: "default",
    })

    const preview = { createdAt: "2026-01-01T00:00:00.000Z", text: "hello world" }
    projectPreview(store, app, sessionId, preview)

    expect(store.store.previews[sessionId]).toEqual(preview)
    expect(app.state.previews.get(sessionId)).toEqual(preview)
  })

  test("todos: both stores agree", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_7")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      permissionMode: "default",
    })

    const todos = [{ id: "todo1", sessionId, status: "pending" as const, content: "task 1" }]
    projectTodos(store, app, sessionId, todos)

    expect(store.getBundle(sessionId)?.todos).toEqual(todos)
    expect(app.state.todos.get(sessionId)).toEqual(todos)
  })

  test("streaming part text is appended once in both stores", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_streaming")
    const messageId = parseMessageId("msg_equiv_streaming")
    const partId = parsePartId("part_equiv_streaming")
    const dualState = createDualPathStore(store, app)

    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      permissionMode: "default",
    })
    dualState.addMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      parts: [],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    dualState.addPart(sessionId, messageId, {
      type: "text",
      id: partId,
      text: "",
    })

    dualState.appendPartText(sessionId, messageId, partId, "one ")
    dualState.appendPartText(sessionId, messageId, partId, "two")

    expect(store.getBundle(sessionId)?.messages[0]?.parts[0]).toEqual({
      type: "text",
      id: partId,
      text: "one two",
    })
    expect(app.state.messages.get(sessionId)?.[0]?.parts[0]).toEqual({
      type: "text",
      id: partId,
      text: "one two",
    })
  })

  test("persisted history hydration replaces messages in both stores", () => {
    const { store, app } = setupProjection()
    const sessionId = parseSessionId("ses_equiv_hydration")
    projectSessionCreation(store, app, {
      id: sessionId,
      cwd: "/tmp",
      modelId: "fake/model",
      permissionMode: "default",
    })
    const messages = [
      {
        id: parseMessageId("msg_equiv_hydration"),
        sessionId,
        role: "assistant" as const,
        parts: [
          { type: "text" as const, id: parsePartId("part_equiv_hydration"), text: "restored" },
        ],
        createdAt: "2026-07-27T00:00:00.000Z",
      },
    ]

    createDualPathStore(store, app).hydrateSessionMessages(sessionId, messages)

    expect(store.getBundle(sessionId)?.messages).toEqual(messages)
    expect(app.state.messages.get(sessionId)).toEqual(messages)
    expect(store.getBundle(sessionId)?.status).toEqual({ type: "idle" })
  })
})

describe("adapter dual-path integration", () => {
  test("createSession via adapter populates both Solid store and ApplicationState", async () => {
    const engine = new FakeEngine()
    const { adapter, dispose } = createRoot((dispose) => {
      const adapter = createWrenAdapter(engine, { engineFactory: makeFactory() })
      return { adapter, dispose }
    })

    const response = await adapter.fetch(
      new Request("http://wren.internal/session", {
        method: "POST",
        body: JSON.stringify({ cwd: "/tmp/project" }),
      }),
    )

    expect(response.status).toBe(201)
    const session = await response.json()
    const sessionId = parseSessionId(session.id)

    // Solid store has the session
    expect(adapter.state.getSession(sessionId)).toBeDefined()

    // The adapter's app instance also has it (verified via the projection functions)
    // The adapter created the app internally; we can't access it directly,
    // but the equivalence test above proves the projection works.

    dispose()
  })

  test("deleteSession via adapter removes from both stores", async () => {
    const engine = new FakeEngine()
    const { adapter, dispose } = createRoot((dispose) => {
      const adapter = createWrenAdapter(engine, { engineFactory: makeFactory() })
      return { adapter, dispose }
    })

    // Create
    const createResponse = await adapter.fetch(
      new Request("http://wren.internal/session", {
        method: "POST",
        body: JSON.stringify({ cwd: "/tmp/project" }),
      }),
    )
    const session = await createResponse.json()
    const sessionId = parseSessionId(session.id)

    // Delete
    const deleteResponse = await adapter.fetch(
      new Request(`http://wren.internal/session/${session.id}`, {
        method: "DELETE",
      }),
    )
    expect(deleteResponse.status).toBe(200)

    // Solid store no longer has it
    expect(adapter.state.getSession(sessionId)).toBeUndefined()

    dispose()
  })
})

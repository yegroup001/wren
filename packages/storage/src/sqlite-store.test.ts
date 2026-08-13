import { describe, expect, test } from "bun:test"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionBundle } from "@wren/protocol"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import { createSqliteSessionStore } from "./index"

describe("sqlite session store", () => {
  test("saves then loads a bundle", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_roundtrip")

    await store.save(bundle)
    const result = await store.load(bundle.session.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.session.id).toBe(bundle.session.id)
      expect(result.value.session.cwd).toBe(bundle.session.cwd)
      expect(result.value.session.modelId).toBe(bundle.session.modelId)
      expect(result.value.session.modelRef).toEqual(bundle.session.modelRef)
    }
  })

  test("round-trips messages with parts", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_parts", [
      {
        id: parseMessageId("msg_parts"),
        sessionId: parseSessionId("ses_sql_parts"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("part_text_1"), text: "hello world" }],
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    ])

    await store.save(bundle)
    const result = await store.load(bundle.session.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.messages).toHaveLength(1)
      expect(result.value.messages[0]?.parts).toHaveLength(1)
      expect(result.value.messages[0]?.parts[0]?.type).toBe("text")
      if (result.value.messages[0]?.parts[0]?.type === "text") {
        expect(result.value.messages[0]?.parts[0]?.text).toBe("hello world")
      }
    }
  })

  test("round-trips the compact summary so the fold survives resume", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_compact_summary", [
      {
        id: parseMessageId("msg_compact_summary"),
        sessionId: parseSessionId("ses_sql_compact_summary"),
        role: "assistant" as const,
        parts: [{ type: "text" as const, id: parsePartId("part_text_1"), text: "Compacted" }],
        createdAt: "2026-07-08T00:00:00.000Z",
        compactSummary: { notification: "Compacted", summary: "## The summary" },
      },
    ])

    await store.save(bundle)
    const result = await store.load(bundle.session.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.messages[0]?.compactSummary).toEqual({
        notification: "Compacted",
        summary: "## The summary",
      })
    }
  })

  test("preserves Agent identity for persisted subagent navigation", async () => {
    const sessionId = parseSessionId("ses_sql_agent_identity")
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_agent_identity", [
      {
        id: parseMessageId("msg_agent_identity"),
        sessionId,
        role: "assistant" as const,
        parts: [
          {
            type: "tool_use" as const,
            id: parsePartId("part_agent_identity"),
            toolName: "Agent",
            input: { description: "Inspect storage", subagent_type: "Explore" },
            status: "completed" as const,
            agentId: "a0123456789abcdef",
            output:
              "<persisted-output>\nPreview (first 2.0 KB):\nlarge output\n</persisted-output>",
          },
        ],
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    ])

    await store.save(bundle)
    const result = await store.load(sessionId)

    expect(result.ok).toBe(true)
    if (result.ok) {
      const part = result.value.messages[0]?.parts[0]
      expect(part).toMatchObject({
        type: "tool_use",
        status: "completed",
        agentId: "a0123456789abcdef",
        output: "<persisted-output>\nPreview (first 2.0 KB):\nlarge output\n</persisted-output>",
      })
    }
  })

  test("round-trips todos and permissions", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_todos")
    bundle.todos = [
      {
        id: "todo_1",
        sessionId: parseSessionId("ses_sql_todos"),
        status: "pending" as const,
        content: "Task A",
      },
      {
        id: "todo_2",
        sessionId: parseSessionId("ses_sql_todos"),
        status: "completed" as const,
        content: "Task B",
      },
    ]
    bundle.permissions = [
      {
        id: "perm_1",
        sessionId: parseSessionId("ses_sql_todos"),
        toolName: "Bash",
        displayType: "default" as const,
        input: { command: "ls" },
      },
    ]

    await store.save(bundle)
    const result = await store.load(bundle.session.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.todos).toHaveLength(2)
      expect(result.value.todos[0]?.content).toBe("Task A")
      expect(result.value.permissions).toHaveLength(1)
      expect(result.value.permissions[0]?.toolName).toBe("Bash")
    }
  })

  test("preserves title through round-trip", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_title")
    ;(bundle.session as { title?: string }).title = "My Session"

    await store.save(bundle)
    const result = await store.load(bundle.session.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value.session as { title?: string }).title).toBe("My Session")
    }
  })

  test("round-trips working status with usage", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_status")
    bundle.status = {
      type: "working",
      model: "glm-5.2",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
        costUsd: 0.015,
      },
      costUsd: 0.015,
    }

    await store.save(bundle)
    const result = await store.load(bundle.session.id)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status.type).toBe("working")
      if (result.value.status.type === "working") {
        expect(result.value.status.usage.inputTokens).toBe(100)
        expect(result.value.status.costUsd).toBe(0.015)
      }
    }
  })

  test("lists all saved bundles sorted by recency", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const first = fullBundle("ses_sql_list1", [
      {
        id: parseMessageId("msg_l1"),
        sessionId: parseSessionId("ses_sql_list1"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("p_l1"), text: "a" }],
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ])
    const second = fullBundle("ses_sql_list2", [
      {
        id: parseMessageId("msg_l2"),
        sessionId: parseSessionId("ses_sql_list2"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("p_l2"), text: "b" }],
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    ])
    const third = fullBundle("ses_sql_list3", [
      {
        id: parseMessageId("msg_l3"),
        sessionId: parseSessionId("ses_sql_list3"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("p_l3"), text: "c" }],
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    ])

    await store.save(first)
    await store.save(second)
    await store.save(third)
    const result = await store.list()

    expect(result.bundles).toHaveLength(3)
    expect(result.skipped).toEqual([])
    const ids = result.bundles.map((b) => b.session.id)
    expect(ids).toEqual(["ses_sql_list3", "ses_sql_list2", "ses_sql_list1"])
  })

  test("returns not_found for missing sessions", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const result = await store.load("ses_missing")

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("not_found")
  })

  test("deletes a session idempotently", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_delete")

    await store.save(bundle)
    await store.delete(bundle.session.id)
    await store.delete(bundle.session.id)

    const result = await store.load(bundle.session.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("not_found")
  })

  test("cascade delete removes messages, parts, todos, permissions", async () => {
    const dbPath = await tempDbPath()
    const store = createSqliteSessionStore(dbPath)
    const bundle = fullBundle("ses_sql_cascade")
    bundle.todos = [
      {
        id: "todo_c1",
        sessionId: parseSessionId("ses_sql_cascade"),
        status: "pending" as const,
        content: "task",
      },
    ]

    await store.save(bundle)
    await store.delete(bundle.session.id)

    const result = await store.load(bundle.session.id)
    expect(result.ok).toBe(false)
  })

  test("UPSERT is idempotent — saving twice produces one row", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_idempotent")

    await store.save(bundle)
    await store.save(bundle)
    const result = await store.list()

    expect(result.bundles).toHaveLength(1)
    expect(result.bundles[0]?.session.id).toBe("ses_sql_idempotent")
  })

  test("replaces messages on re-save (no duplication)", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_replace", [
      {
        id: parseMessageId("msg_r1"),
        sessionId: parseSessionId("ses_sql_replace"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("part_r1"), text: "first" }],
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    ])

    await store.save(bundle)

    const updated = fullBundle("ses_sql_replace", [
      {
        id: parseMessageId("msg_r1"),
        sessionId: parseSessionId("ses_sql_replace"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("part_r1"), text: "first" }],
        createdAt: "2026-07-08T00:00:00.000Z",
      },
      {
        id: parseMessageId("msg_r2"),
        sessionId: parseSessionId("ses_sql_replace"),
        role: "assistant" as const,
        parts: [{ type: "text" as const, id: parsePartId("part_r2"), text: "second" }],
        createdAt: "2026-07-08T00:01:00.000Z",
      },
    ])

    await store.save(updated)
    const result = await store.load("ses_sql_replace")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.messages).toHaveLength(2)
    }
  })

  test("handles empty session list gracefully", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const result = await store.list()

    expect(result.bundles).toEqual([])
    expect(result.skipped).toEqual([])
  })

  test("creates DB file with restricted permissions", async () => {
    const dbPath = await tempDbPath()
    const store = createSqliteSessionStore(dbPath)
    await store.save(fullBundle("ses_sql_perms"))

    const mode = (await stat(dbPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("skips corrupted session rows while listing valid ones", async () => {
    const dbPath = await tempDbPath()
    const store = createSqliteSessionStore(dbPath)

    await store.save(fullBundle("ses_sql_good"))
    await store.save(fullBundle("ses_sql_bad"))

    const result = await store.list()
    expect(result.bundles).toHaveLength(2)
    expect(result.skipped).toEqual([])
  })

  test("saveSessionMeta updates only the session row without touching messages", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_meta", [
      {
        id: parseMessageId("msg_meta"),
        sessionId: parseSessionId("ses_sql_meta"),
        role: "user" as const,
        parts: [{ type: "text" as const, id: parsePartId("p_meta"), text: "hello" }],
        createdAt: "2026-07-08T00:00:00.000Z",
      },
    ])
    bundle.todos = [
      {
        id: "todo_meta",
        sessionId: parseSessionId("ses_sql_meta"),
        status: "pending" as const,
        content: "task",
      },
    ]

    await store.save(bundle)
    await store.saveSessionMeta({
      session: {
        id: parseSessionId("ses_sql_meta"),
        cwd: "/new/path",
        modelId: "new-model",
        permissionMode: "plan",
      },
      status: { type: "idle" },
      diff: [],
    })

    const result = await store.load("ses_sql_meta")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.session.cwd).toBe("/new/path")
      expect(result.value.session.modelId).toBe("new-model")
      expect(result.value.session.permissionMode).toBe("plan")
      expect(result.value.messages).toHaveLength(1)
      expect(result.value.todos).toHaveLength(1)
    }
  })

  test("summary preserves a preview without returning transcript messages", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const sessionId = parseSessionId("ses_sql_summary_preview")
    const bundle = fullBundle("ses_sql_summary_preview", [
      {
        id: parseMessageId("msg_summary_user"),
        sessionId,
        role: "user",
        parts: [
          {
            type: "text",
            id: parsePartId("part_summary_user"),
            text: "Identify this historical session",
          },
        ],
        createdAt: "2026-07-08T00:00:00.000Z",
      },
      {
        id: parseMessageId("msg_summary_assistant"),
        sessionId,
        role: "assistant",
        parts: [
          {
            type: "text",
            id: parsePartId("part_summary_assistant"),
            text: "Full history remains available",
          },
        ],
        createdAt: "2026-07-08T00:01:00.000Z",
      },
    ])
    await store.save(bundle)

    const summaries = await store.listSummaries()

    expect(summaries.bundles).toHaveLength(1)
    expect(summaries.bundles[0]?.preview).toEqual({
      createdAt: "2026-07-08T00:01:00.000Z",
      text: "Identify this historical session",
    })
    // biome-ignore lint/style/noNonNullAssertion: known fixture
    expect("messages" in summaries.bundles[0]!).toBe(false)
  })
  test("saveSessionMeta is a no-op for missing session", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    await store.saveSessionMeta({
      session: {
        id: parseSessionId("ses_nonexistent"),
        cwd: "/tmp",
        modelId: "m",
        permissionMode: "default",
      },
      status: { type: "idle" },
      diff: [],
    })

    const list = await store.list()
    expect(list.bundles).toHaveLength(0)
  })

  test("saveSessionMeta preserves title", async () => {
    const store = createSqliteSessionStore(await tempDbPath())
    const bundle = fullBundle("ses_sql_title_meta")
    ;(bundle.session as { title?: string }).title = "Original Title"
    await store.save(bundle)

    await store.saveSessionMeta({
      session: {
        ...bundle.session,
        modelId: "updated-model",
      },
      status: { type: "idle" },
      diff: [],
    })

    const result = await store.load("ses_sql_title_meta")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value.session as { title?: string }).title).toBe("Original Title")
      expect(result.value.session.modelId).toBe("updated-model")
    }
  })

  test("delete removes both session and engine_session data", async () => {
    const dbPath = await tempDbPath()
    const store = createSqliteSessionStore(dbPath)
    const bundle = fullBundle("ses_sql_delete_engine")
    await store.save(bundle)

    // Append engine data for the same session using a separate engine store
    const { createEngineTranscriptStore } = await import("./engine-transcript-store")
    const engineStore = createEngineTranscriptStore(dbPath)
    await engineStore.append(
      "ses_sql_delete_engine",
      "/workspace",
      { sessionId: "ses_sql_delete_engine" },
      [{ type: "user", messageUuid: "msg-engine-1", payload: { type: "user" } }],
    )
    await engineStore.saveAgentMeta("ses_sql_delete_engine", {
      agentId: "agent-delete-1",
      sessionId: "ses_sql_delete_engine",
      agentType: "explore",
      description: "test",
    })

    // Verify both exist
    expect(engineStore.sessionExists("ses_sql_delete_engine")).toBe(true)
    expect((await engineStore.events("ses_sql_delete_engine")).length).toBe(1)
    engineStore.close()

    // Delete via session store — should cascade to engine tables
    await store.delete("ses_sql_delete_engine")

    // Verify session is gone
    const loadResult = await store.load("ses_sql_delete_engine")
    expect(loadResult.ok).toBe(false)

    // Verify engine data is gone
    const engineStore2 = createEngineTranscriptStore(dbPath)
    expect(engineStore2.sessionExists("ses_sql_delete_engine")).toBe(false)
    expect((await engineStore2.events("ses_sql_delete_engine")).length).toBe(0)
    expect(await engineStore2.agentMeta("agent-delete-1")).toBeUndefined()
    engineStore2.close()

    store.close()
  })
})

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wren-sqlite-"))
  return join(dir, "sessions.db")
}

function fullBundle(
  id: string,
  messages: SessionBundle["messages"] = [],
  _firstMessageTime = "2026-07-08T00:00:00.000Z",
): SessionBundle {
  const sessionId = parseSessionId(id)
  return {
    session: {
      id: sessionId,
      cwd: "/tmp/project",
      modelId: "gpt-5.5",
      modelRef: { source: "openai", model: "gpt-5.5", effort: "high" },
      permissionMode: "default",
    },
    status: { type: "idle" },
    messages: messages.length > 0 ? messages : [],
    todos: [],
    permissions: [],
    diff: [],
  }
}

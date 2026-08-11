import { describe, expect, test } from "bun:test"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import { createComputed, createRoot } from "solid-js"
import { createTuiStore } from "./store"

describe("compact progress", () => {
  test("preserves ordered text/thinking segments and clears without touching messages", () => {
    const sessionId = parseSessionId("ses_compact_progress")
    const store = createTuiStore()
    store.addSession({
      id: sessionId,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "default",
    })
    const messageId = parseMessageId("msg_existing")
    store.addMessage({
      id: messageId,
      sessionId,
      role: "user",
      parts: [{ type: "text", id: parsePartId("part_existing"), text: "keep me" }],
      createdAt: "2026-07-27T00:00:00.000Z",
    })

    store.setCompactProgress(sessionId, { phase: "summarizing", segments: [] })
    store.appendCompactProgress(sessionId, "text", "first")
    store.appendCompactProgress(sessionId, "text", " text")
    store.appendCompactProgress(sessionId, "thinking", "reasoning")
    store.appendCompactProgress(sessionId, "text", "second")

    expect(store.store.compactProgress[sessionId]).toEqual({
      phase: "summarizing",
      segments: [
        { type: "text", text: "first text" },
        { type: "thinking", text: "reasoning" },
        { type: "text", text: "second" },
      ],
    })
    store.clearCompactProgress(sessionId)
    expect(store.store.compactProgress[sessionId]).toBeUndefined()
    expect(store.store.messages[sessionId]?.[0]?.id).toBe(messageId)
  })
})

describe("restoreConversation", () => {
  test("restores the session permission mode with conversation projections", () => {
    const sessionId = parseSessionId("ses_restore_mode")
    const store = createTuiStore()
    store.addSession({
      id: sessionId,
      cwd: "/tmp/project",
      modelId: "glm-5.2",
      permissionMode: "plan",
    })
    store.setSessionPermissionMode(sessionId, "default")

    store.restoreConversation(sessionId, {
      messages: [],
      todos: [],
      status: { type: "idle" },
      diff: { sessionId, files: [], updatedAt: "" },
      permissionMode: "plan",
      permissions: [],
      questions: [],
    })

    expect(store.getSession(sessionId)?.permissionMode).toBe("plan")
  })
})

describe("hydrateSessionMessages", () => {
  test("commits persisted history as one reactive update", () => {
    const sessionId = parseSessionId("ses_hydrate_atomic")
    const messages = Array.from({ length: 5000 }, (_, index) => ({
      id: parseMessageId(`msg_hydrate_${index}`),
      sessionId,
      role: "assistant" as const,
      parts: [
        {
          type: "text" as const,
          id: parsePartId(`part_hydrate_${index}`),
          text: `message ${index}`,
        },
      ],
      createdAt: "2026-07-27T00:00:00.000Z",
    }))

    createRoot((dispose) => {
      const store = createTuiStore()
      const observedLengths: number[] = []
      createComputed(() => {
        const loaded = store.store.messages[sessionId]
        if (loaded !== undefined) observedLengths.push(loaded.length)
      })

      store.hydrateSessionMessages(sessionId, messages)

      expect(observedLengths).toEqual([5000])
      expect(store.store.messages[sessionId]?.[0]?.id).toBe(messages[0]?.id)
      expect(store.store.messages[sessionId]?.at(-1)?.id).toBe(messages.at(-1)?.id)
      dispose()
    })
  })
})

describe("appendPartText fast path", () => {
  function setupAppend() {
    const store = createTuiStore()
    const sessionId = parseSessionId("ses_append_fast")
    store.addSession({ id: sessionId, cwd: "/tmp", modelId: "fake/model", permissionMode: "default" })
    return { store, sessionId }
  }

  function textPart(id: string, text: string) {
    return { type: "text" as const, id: parsePartId(id), text }
  }

  test("appends text and preserves the messages array identity per token", () => {
    const { store, sessionId } = setupAppend()
    const messageId = parseMessageId("msg_fast_1")
    store.addMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      parts: [textPart("part_fast_1", "")],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    const arrayBefore = store.store.messages[sessionId]
    const messageBefore = arrayBefore?.[0]

    store.appendPartText(sessionId, messageId, parsePartId("part_fast_1"), "one ")
    store.appendPartText(sessionId, messageId, parsePartId("part_fast_1"), "two")

    expect(store.store.messages[sessionId]?.[0]?.parts[0]).toEqual({
      type: "text",
      id: parsePartId("part_fast_1"),
      text: "one two",
    })
    // The array identity must survive streamed appends — the transcript
    // relies on it to avoid re-diffing the visible window per token.
    expect(store.store.messages[sessionId]).toBe(arrayBefore)
    expect(store.store.messages[sessionId]?.[0]).toBe(messageBefore)
  })

  test("appends to thinking parts too", () => {
    const { store, sessionId } = setupAppend()
    const messageId = parseMessageId("msg_fast_think")
    store.addMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      parts: [
        { type: "thinking", id: parsePartId("part_fast_think"), text: "" },
        textPart("part_fast_txt", ""),
      ],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    store.appendPartText(sessionId, messageId, parsePartId("part_fast_think"), "reasoning")
    store.appendPartText(sessionId, messageId, parsePartId("part_fast_txt"), "answer")
    expect(store.store.messages[sessionId]?.[0]?.parts[0]).toEqual({
      type: "thinking",
      id: parsePartId("part_fast_think"),
      text: "reasoning",
    })
    expect(store.store.messages[sessionId]?.[0]?.parts[1]).toEqual({
      type: "text",
      id: parsePartId("part_fast_txt"),
      text: "answer",
    })
  })

  test("index map stays correct across structural mutations", () => {
    const { store, sessionId } = setupAppend()
    const first = parseMessageId("msg_fast_a")
    const second = parseMessageId("msg_fast_b")
    const third = parseMessageId("msg_fast_c")
    store.addMessage({
      id: first,
      sessionId,
      role: "user",
      parts: [textPart("part_fast_a", "first")],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    store.addMessage({
      id: second,
      sessionId,
      role: "assistant",
      parts: [textPart("part_fast_b", "")],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    // Insert before the queued marker
    store.addMessage({
      id: parseMessageId("msg_fast_queued"),
      sessionId,
      role: "user",
      queued: true,
      parts: [textPart("part_fast_q", "queued")],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    store.addMessageBeforeQueued({
      id: third,
      sessionId,
      role: "assistant",
      parts: [textPart("part_fast_c", "")],
      createdAt: "2026-07-27T00:00:00.000Z",
    })
    // Remove the first message — indices shift
    store.removeMessage(sessionId, first)

    store.appendPartText(sessionId, third, parsePartId("part_fast_c"), "streamed")
    expect(store.store.messages[sessionId]?.[0]?.id).toBe(second)
    expect(store.store.messages[sessionId]?.[1]?.id).toBe(third)
    expect(store.store.messages[sessionId]?.[1]?.parts[0]).toEqual({
      type: "text",
      id: parsePartId("part_fast_c"),
      text: "streamed",
    })
  })

  test("appendPartText is a no-op for unknown sessions, messages, and parts", () => {
    const { store, sessionId } = setupAppend()
    const messageId = parseMessageId("msg_fast_nope")
    store.appendPartText(sessionId, messageId, parsePartId("part_fast_nope"), "x")
    store.appendPartText(parseSessionId("ses_unknown"), messageId, parsePartId("part_fast_nope"), "x")
    expect(store.store.messages[sessionId]).toBeUndefined()
  })

  test("index map survives restore and hydration", () => {
    const { store, sessionId } = setupAppend()
    const messageId = parseMessageId("msg_fast_restore")
    const partId = parsePartId("part_fast_restore")
    store.restoreConversation(sessionId, {
      messages: [
        {
          id: messageId,
          sessionId,
          role: "assistant",
          parts: [{ type: "text", id: partId, text: "" }],
          createdAt: "2026-07-27T00:00:00.000Z",
        },
      ],
      todos: [],
      status: { type: "idle" },
      diff: { sessionId, files: [], updatedAt: "" },
      permissionMode: "default",
      permissions: [],
      questions: [],
    })
    store.appendPartText(sessionId, messageId, partId, "after restore")
    expect(store.store.messages[sessionId]?.[0]?.parts[0]).toEqual({
      type: "text",
      id: partId,
      text: "after restore",
    })
  })
})

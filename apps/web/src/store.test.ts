import { describe, expect, test } from "bun:test"
import type { Message, Session, Todo } from "@wren/protocol"
import { parseMessageId, parsePartId, parseSessionId } from "@wren/protocol"
import { applyPatch, EMPTY_SNAPSHOT } from "./store"

function message(id: string, text: string): Message {
  return {
    id: parseMessageId(id),
    sessionId: parseSessionId("ses_1"),
    role: "assistant",
    parts: [{ type: "text", id: parsePartId(`part_${id}`), text }],
    createdAt: "2026-08-14T00:00:00.000Z",
  }
}

function session(id: string): Session {
  return {
    id: parseSessionId(id),
    cwd: "/tmp",
    modelId: "m",
    permissionMode: "auto",
  }
}

function todo(id: string, status: Todo["status"]): Todo {
  return {
    id,
    sessionId: parseSessionId("ses_1"),
    status,
    content: "x",
  }
}

describe("applyPatch", () => {
  test("replaces top-level fields wholesale when present", () => {
    const state = { ...EMPTY_SNAPSHOT }
    const next = applyPatch(state, { sessions: [session("ses_1")] })
    expect(next.sessions).toHaveLength(1)
    expect(next.messages).toEqual({})
    expect(state.sessions).toHaveLength(0)
  })

  test("leaves absent fields untouched", () => {
    const state = { ...EMPTY_SNAPSHOT, todos: { ses_1: [todo("t1", "pending")] } }
    const next = applyPatch(state, { sessions: [session("s")] })
    expect(next.todos).toBe(state.todos)
  })

  test("upsert replaces messages by id in place", () => {
    const state = {
      ...EMPTY_SNAPSHOT,
      messages: { ses_1: [message("m1", "one"), message("m2", "two")] },
    }
    const next = applyPatch(state, {
      messages: [{ sessionId: "ses_1", mode: "upsert", messages: [message("m2", "TWO")] }],
    })
    expect(next.messages["ses_1"]?.map((m) => m.id)).toEqual([
      message("m1", "").id,
      message("m2", "").id,
    ])
    expect(next.messages["ses_1"]?.[1]?.parts[0]).toMatchObject({ text: "TWO" })
  })

  test("upsert appends unknown message ids at the end", () => {
    const state = { ...EMPTY_SNAPSHOT, messages: { ses_1: [message("m1", "one")] } }
    const next = applyPatch(state, {
      messages: [{ sessionId: "ses_1", mode: "upsert", messages: [message("m2", "two")] }],
    })
    expect(next.messages["ses_1"]?.map((m) => m.id)).toEqual([
      message("m1", "").id,
      message("m2", "").id,
    ])
  })

  test("replaceAll replaces the whole array (removals, reorder)", () => {
    const state = {
      ...EMPTY_SNAPSHOT,
      messages: { ses_1: [message("m1", "one"), message("m2", "two")] },
    }
    const next = applyPatch(state, {
      messages: [{ sessionId: "ses_1", mode: "replaceAll", messages: [message("m3", "three")] }],
    })
    expect(next.messages["ses_1"]?.map((m) => m.id)).toEqual([message("m3", "").id])
  })

  test("streaming updates only touch the target message", () => {
    const state = {
      ...EMPTY_SNAPSHOT,
      messages: {
        ses_1: [message("m1", "one"), message("m2", "two")],
        ses_2: [message("x1", "x")],
      },
    }
    const next = applyPatch(state, {
      messages: [
        {
          sessionId: "ses_1",
          mode: "upsert",
          messages: [message("m2", "two more tokens")],
        },
      ],
    })
    expect(next.messages["ses_1"]?.[0]).toBe(state.messages["ses_1"]?.[0])
    expect(next.messages["ses_2"]).toBe(state.messages["ses_2"])
  })

  test("missing session in messages patch starts a new entry", () => {
    const state = { ...EMPTY_SNAPSHOT }
    const next = applyPatch(state, {
      messages: [{ sessionId: "ses_new", mode: "upsert", messages: [message("m1", "hi")] }],
    })
    expect(next.messages["ses_new"]?.map((m) => m.id)).toEqual([message("m1", "").id])
  })

  test("empty patch is a no-op", () => {
    const state = { ...EMPTY_SNAPSHOT }
    const next = applyPatch(state, {})
    expect(next).toEqual(state)
  })
})

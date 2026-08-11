import { describe, expect, test } from "bun:test"
import { parseSessionId } from "@wren/protocol"
import { createMemorySessionStore } from "./index"

describe("memory session store", () => {
  test("returns not_found for missing sessions", async () => {
    const store = createMemorySessionStore()
    const result = await store.load("ses_missing")

    expect(result.ok).toBe(false)
  })

  test("saves and loads a bundle", async () => {
    const store = createMemorySessionStore()
    const sessionId = parseSessionId("ses_fixture")
    const bundle = {
      session: {
        id: sessionId,
        cwd: "/tmp/project",
        modelId: "gpt-5.5",
        permissionMode: "default",
      },
      status: { type: "idle" as const },
      messages: [],
      todos: [],
      permissions: [],
      diff: [],
    }

    await store.save(bundle)
    const result = await store.load(sessionId)

    expect(result.ok).toBe(true)
  })
})

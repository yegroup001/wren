import { describe, expect, test } from "bun:test"
import type { SessionId } from "@wren/protocol"
import type { Route } from "./route"

describe("Route types", () => {
  test("home route type", () => {
    const home: Route = { type: "home" }
    expect(home.type).toBe("home")
  })

  test("session route type", () => {
    const session: Route = { type: "session", sessionId: "s1" as SessionId }
    expect(session.type).toBe("session")
    if (session.type === "session") {
      expect(session.sessionId).toBe("s1")
    }
  })

  test("session-list route type", () => {
    const list: Route = { type: "session-list" }
    expect(list.type).toBe("session-list")
  })

  test("subagent route type", () => {
    const subagent: Route = {
      type: "subagent",
      sessionId: "s1" as SessionId,
      agentId: "a1",
      description: "test",
    }
    expect(subagent.type).toBe("subagent")
    if (subagent.type === "subagent") {
      expect(subagent.agentId).toBe("a1")
      expect(subagent.description).toBe("test")
    }
  })
})

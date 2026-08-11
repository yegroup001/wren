import { describe, expect, test } from "bun:test"
import { createWrenRequest } from "./request"

describe("createWrenRequest", () => {
  test("resolves an internal API path", () => {
    const request = createWrenRequest("/session/ses_1/messages")
    expect(request.url).toBe("http://wren.internal/session/ses_1/messages")
    expect(request.method).toBe("GET")
  })

  test("preserves query strings", () => {
    const request = createWrenRequest("/session/ses_1/messages?limit=20")
    expect(request.url).toBe("http://wren.internal/session/ses_1/messages?limit=20")
  })

  test("preserves method, headers, and body", () => {
    const request = createWrenRequest("/session/ses_1/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    })
    expect(request.method).toBe("POST")
    expect(request.headers.get("content-type")).toBe("application/json")
    expect(request.json()).resolves.toEqual({ prompt: "hello" })
  })
})

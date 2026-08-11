import { describe, expect, test } from "bun:test"
import { HIDDEN_UNSUPPORTED_SURFACES } from "./view-model"

describe("HIDDEN_UNSUPPORTED_SURFACES", () => {
  test("is a non-empty readonly array", () => {
    expect(HIDDEN_UNSUPPORTED_SURFACES.length).toBeGreaterThan(0)
  })

  test("contains cloud account", () => {
    expect(HIDDEN_UNSUPPORTED_SURFACES).toContain("cloud account")
  })

  test("contains upgrade prompts", () => {
    expect(HIDDEN_UNSUPPORTED_SURFACES).toContain("upgrade prompts")
  })

  test("contains plugin marketplace", () => {
    expect(HIDDEN_UNSUPPORTED_SURFACES).toContain("plugin marketplace")
  })

  test("contains background subagents", () => {
    expect(HIDDEN_UNSUPPORTED_SURFACES).toContain("background subagents")
  })

  test("all entries are lowercase strings", () => {
    for (const entry of HIDDEN_UNSUPPORTED_SURFACES) {
      expect(typeof entry).toBe("string")
      expect(entry).toBe(entry.toLowerCase())
    }
  })
})

import { describe, expect, test } from "bun:test"
import { getToolUseSummary, userFacingName } from "../UI.js"

describe("GrepTool headless UI", () => {
  test("reports user-facing name", () => {
    expect(userFacingName()).toBe("Grep")
  })

  test("summarizes the search pattern with location", () => {
    const input = { pattern: "TODO", path: "/workspace/src", output_mode: "content" }
    expect(getToolUseSummary(input)).toBe("TODO in /workspace/src")
  })

  test("summarizes the pattern without a location", () => {
    expect(getToolUseSummary({ pattern: "TODO" })).toBe("TODO")
  })

  test("returns null for an empty pattern", () => {
    expect(getToolUseSummary({ pattern: "" })).toBeNull()
    expect(getToolUseSummary(undefined)).toBeNull()
  })
})

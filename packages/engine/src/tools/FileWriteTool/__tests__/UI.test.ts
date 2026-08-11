import { describe, expect, test } from "bun:test"
import { getToolUseSummary, userFacingName } from "../UI.js"

describe("FileWriteTool headless UI", () => {
  test("reports user-facing name", () => {
    expect(userFacingName()).toBe("Write")
  })

  test("summarizes the target file path", () => {
    const input = { file_path: "/workspace/app.ts", content: "const x = 1" }
    expect(getToolUseSummary(input)).toBe("/workspace/app.ts")
  })

  test("returns null without a file path", () => {
    expect(getToolUseSummary({})).toBeNull()
    expect(getToolUseSummary(undefined)).toBeNull()
  })
})

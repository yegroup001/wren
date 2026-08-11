import { describe, expect, test } from "bun:test"
import { getToolUseSummary, userFacingName } from "../UI.js"

describe("FileReadTool headless UI", () => {
  test("reports user-facing name", () => {
    expect(userFacingName()).toBe("Read")
  })

  test("summarizes the target file path", () => {
    const input = { file_path: "/workspace/app.ts", offset: 10, limit: 5 }
    expect(getToolUseSummary(input)).toBe("/workspace/app.ts")
  })

  test("returns null without a file path", () => {
    expect(getToolUseSummary(undefined)).toBeNull()
  })
})

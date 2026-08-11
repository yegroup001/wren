import { describe, expect, test } from "bun:test"
import { getToolUseSummary, userFacingName } from "../UI.js"

const input = {
  file_path: "/workspace/app.ts",
  old_string: "old",
  new_string: "new",
  replace_all: false,
}

describe("FileEditTool headless UI", () => {
  test("uses the Edit user-facing name and file path summary", () => {
    expect(userFacingName()).toBe("Edit")
    expect(getToolUseSummary(input)).toBe("/workspace/app.ts")
    expect(getToolUseSummary(undefined)).toBeNull()
  })
})

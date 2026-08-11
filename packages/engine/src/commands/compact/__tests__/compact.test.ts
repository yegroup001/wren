import { describe, expect, test } from "bun:test"
import { buildDisplayText } from "../compact.js"

describe("buildDisplayText", () => {
  test("keeps the plain 'Compacted' text without a summary", () => {
    expect(buildDisplayText()).toContain("Compacted")
    expect(buildDisplayText()).not.toContain("<compact-summary>")
  })

  test("embeds the summary in a <compact-summary> marker for the mapper", () => {
    const text = buildDisplayText({ summaryText: "Summary:\n- kept the setup" })
    expect(text).toContain("<compact-summary>Summary:\n- kept the setup</compact-summary>")
    expect(text.startsWith("Compacted") || text.includes("Compacted")).toBe(true)
  })

  test("omits the marker when summaryText is empty", () => {
    expect(buildDisplayText({ summaryText: "" })).not.toContain("<compact-summary>")
    expect(buildDisplayText({ summaryText: undefined })).not.toContain("<compact-summary>")
  })

  test("includes the hook userDisplayMessage before the marker", () => {
    const text = buildDisplayText({ userDisplayMessage: "Run /compact again", summaryText: "s" })
    expect(text.indexOf("Run /compact again")).toBeLessThan(text.indexOf("<compact-summary>"))
  })
})

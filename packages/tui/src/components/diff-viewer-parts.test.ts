import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@wren/protocol"
import { generatePatch } from "./diff-viewer-parts"

describe("generatePatch", () => {
  test("returns patch string from file", () => {
    const file = {
      path: "a.ts",
      added: 1,
      removed: 0,
      patch: "@@ -1,1 +1,2 @@\n+new",
    } as unknown as SnapshotFileDiff
    expect(generatePatch(file)).toBe("@@ -1,1 +1,2 @@\n+new")
  })

  test("returns empty string when patch is missing", () => {
    const file = { path: "a.ts", added: 1, removed: 0 } as unknown as SnapshotFileDiff
    expect(generatePatch(file)).toBe("")
  })

  test("returns empty string when patch is empty", () => {
    const file = { path: "a.ts", added: 1, removed: 0, patch: "" } as unknown as SnapshotFileDiff
    expect(generatePatch(file)).toBe("")
  })

  test("returns empty string when patch is not a string", () => {
    const file = { path: "a.ts", added: 1, removed: 0, patch: 123 } as unknown as SnapshotFileDiff
    expect(generatePatch(file)).toBe("")
  })
})

import { describe, expect, test } from "bun:test"
import { copyCompletedSelection } from "./selection-copy"

describe("copyCompletedSelection", () => {
  test("copies a completed non-empty selection exactly once", () => {
    const writes: string[] = []
    let clears = 0

    copyCompletedSelection({
      selection: { getSelectedText: () => "selected text" },
      write: (value) => {
        writes.push(value)
      },
      clear: () => {
        clears += 1
      },
    })

    expect(writes).toEqual(["\x1b]52;c;c2VsZWN0ZWQgdGV4dA==\x07"])
    expect(clears).toBe(1)
  })

  test("does not copy or clear an empty selection", () => {
    const writes: string[] = []
    let clears = 0

    copyCompletedSelection({
      selection: { getSelectedText: () => "" },
      write: (value) => {
        writes.push(value)
      },
      clear: () => {
        clears += 1
      },
    })

    expect(writes).toEqual([])
    expect(clears).toBe(0)
  })
})

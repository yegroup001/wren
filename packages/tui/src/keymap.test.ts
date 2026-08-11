import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("keymap dispatch guard", () => {
  test("dispatch should respect defaultPrevented and propagationStopped before processing bindings", () => {
    const source = readFileSync(join(import.meta.dir, "keymap.tsx"), "utf8")
    const dispatchIdx = source.indexOf("function dispatch")
    expect(dispatchIdx).toBeGreaterThan(-1)
    const dispatchEnd = source.indexOf("\n  }", dispatchIdx)
    const dispatchSection = source.slice(dispatchIdx, dispatchEnd)
    expect(dispatchSection).toContain("defaultPrevented")
    expect(dispatchSection).toContain("propagationStopped")
    expect(dispatchSection).not.toContain("currentFocusedEditor")
    expect(dispatchSection).not.toContain('"plainText" in focused')
  })
})

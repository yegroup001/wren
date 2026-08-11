import { describe, expect, test } from "bun:test"
import { useThinking } from "./thinking"

describe("useThinking default context", () => {
  test("defaults to collapsed mode", () => {
    const thinking = useThinking()
    expect(thinking.mode()).toBe("collapsed")
  })

  test("toggle is a no-op in default context", () => {
    const thinking = useThinking()
    thinking.toggle()
    expect(thinking.mode()).toBe("collapsed")
  })

  test("setMode is a no-op in default context", () => {
    const thinking = useThinking()
    thinking.setMode("expanded")
    expect(thinking.mode()).toBe("collapsed")
  })
})

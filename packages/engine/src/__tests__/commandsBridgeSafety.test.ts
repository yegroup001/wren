import { describe, expect, test } from "bun:test"
import clear from "../commands/clear/index.js"
import plan from "../commands/plan/index.js"
import { isBridgeSafeCommand } from "../commands.js"

describe("isBridgeSafeCommand", () => {
  test("allows bridge-safe local-jsx commands", () => {
    expect(isBridgeSafeCommand(plan)).toBe(true)
  })

  test("blocks local commands without explicit bridgeSafe opt-in", () => {
    expect(isBridgeSafeCommand(clear)).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { builtInCommandNames } from "../../commands.js"

describe("removed feedback commands", () => {
  test("does not register issue or share", () => {
    const names = builtInCommandNames()

    expect(names.has("issue")).toBe(false)
    expect(names.has("share")).toBe(false)
  })
})

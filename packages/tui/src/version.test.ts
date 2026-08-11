import { describe, expect, test } from "bun:test"
import { VERSION } from "./version"

describe("VERSION", () => {
  test("is a non-empty string", () => {
    expect(typeof VERSION).toBe("string")
    expect(VERSION.length).toBeGreaterThan(0)
  })

  test("matches semver format", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

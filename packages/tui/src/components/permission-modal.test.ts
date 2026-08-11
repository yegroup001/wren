import { describe, expect, test } from "bun:test"
import { OPTIONS, REPLY_MAP, strField } from "./permission-modal"

describe("OPTIONS", () => {
  test("has three options: once, always, reject", () => {
    expect(OPTIONS).toHaveLength(3)
    expect(OPTIONS.map((o) => o.key)).toEqual(["once", "always", "reject"])
  })

  test("every option has a label", () => {
    for (const opt of OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0)
    }
  })
})

describe("REPLY_MAP", () => {
  test("maps once to once", () => {
    expect(REPLY_MAP.once).toBe("once")
  })

  test("maps always to session", () => {
    expect(REPLY_MAP.always).toBe("session")
  })

  test("maps reject to deny", () => {
    expect(REPLY_MAP.reject).toBe("deny")
  })
})

describe("strField", () => {
  test("extracts string field from object", () => {
    expect(strField({ name: "hello" }, "name")).toBe("hello")
  })

  test("returns empty string for missing key", () => {
    expect(strField({ other: 1 }, "name")).toBe("")
  })

  test("returns empty string for non-object", () => {
    expect(strField(null, "name")).toBe("")
    expect(strField(undefined, "name")).toBe("")
    expect(strField("string", "name")).toBe("")
    expect(strField(42, "name")).toBe("")
  })

  test("returns empty string for non-string value", () => {
    expect(strField({ name: 123 }, "name")).toBe("")
    expect(strField({ name: null }, "name")).toBe("")
    expect(strField({ name: { nested: true } }, "name")).toBe("")
  })

  test("returns empty string for empty string value", () => {
    expect(strField({ name: "" }, "name")).toBe("")
  })
})

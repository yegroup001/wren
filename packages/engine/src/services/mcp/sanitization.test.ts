import { describe, expect, test } from "bun:test"
import { recursivelySanitizeUnicode } from "./sanitization"

describe("recursivelySanitizeUnicode", () => {
  test("removes control, replacement, and hidden Unicode characters", () => {
    expect(recursivelySanitizeUnicode("ok\u0000\u0007\u007f\ufffd\u200b\u202eworld")).toBe(
      "okworld",
    )
  })

  test("does not allow object keys to modify the prototype", () => {
    const sanitized = recursivelySanitizeUnicode(
      JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","safe":"ok"}'),
    ) as Record<string, unknown>

    expect(Object.getPrototypeOf(sanitized)).toBe(null)
    expect(sanitized.polluted).toBeUndefined()
    expect(sanitized.safe).toBe("ok")
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(false)
  })

  test("normalizes ordinary Unicode without removing visible text", () => {
    expect(recursivelySanitizeUnicode("Cafe\u0301 — 中文")).toBe("Café — 中文")
  })

  test("sanitizes nested values and object keys", () => {
    expect(
      recursivelySanitizeUnicode({
        "na\u200bme": "va\u0000lue",
        nested: ["\ufffdclean", { "ke\u202ey": "ok" }],
      }),
    ).toEqual({
      name: "value",
      nested: ["clean", { key: "ok" }],
    })
  })
})

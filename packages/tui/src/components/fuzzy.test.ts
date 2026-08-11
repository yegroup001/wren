import { describe, expect, test } from "bun:test"
import { fuzzyMatch, fuzzyScore, fuzzySort } from "./fuzzy"

describe("fuzzyMatch", () => {
  test("matches when all chars appear in order", () => {
    expect(fuzzyMatch("abc", "aXbXc")).toBe(true)
    expect(fuzzyMatch("abc", "abcdef")).toBe(true)
  })

  test("does not match when chars are out of order", () => {
    expect(fuzzyMatch("abc", "cba")).toBe(false)
  })

  test("does not match when a char is missing", () => {
    expect(fuzzyMatch("abc", "abd")).toBe(false)
  })

  test("is case-insensitive", () => {
    expect(fuzzyMatch("ABC", "abcdef")).toBe(true)
    expect(fuzzyMatch("abc", "ABCDEF")).toBe(true)
  })

  test("empty needle always matches", () => {
    expect(fuzzyMatch("", "anything")).toBe(true)
    expect(fuzzyMatch("", "")).toBe(true)
  })

  test("needle longer than haystack does not match", () => {
    expect(fuzzyMatch("abc", "ab")).toBe(false)
  })
})

describe("fuzzyScore", () => {
  test("returns 0 for empty needle", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
  })

  test("returns -1 for no match", () => {
    expect(fuzzyScore("xyz", "abc")).toBe(-1)
  })

  test("contiguous match at start scores better than scattered", () => {
    const contiguous = fuzzyScore("abc", "abcdef")
    const scattered = fuzzyScore("abc", "aXbXc")
    expect(contiguous).toBeLessThan(scattered)
  })

  test("match at start scores better than match later", () => {
    const atStart = fuzzyScore("ab", "abcdef")
    const later = fuzzyScore("ab", "xyzab")
    expect(atStart).toBeLessThan(later)
  })

  test("is case-insensitive", () => {
    expect(fuzzyScore("abc", "ABC")).toBe(fuzzyScore("ABC", "abc"))
  })
})

describe("fuzzySort", () => {
  const items = ["banana", "band", "abandon", "apple", "cab"]

  test("returns items unchanged for empty query", () => {
    expect(fuzzySort("", items, (x) => x)).toEqual(items)
  })

  test("returns items unchanged for whitespace-only query", () => {
    expect(fuzzySort("   ", items, (x) => x)).toEqual(items)
  })

  test("filters out non-matches", () => {
    const result = fuzzySort("ab", items, (x) => x)
    // "band" has a then b — no wait, b-a-n-d has b before a
    // "abandon" has a then b — yes
    // "cab" has a then b — yes
    expect(result).toContain("abandon")
    expect(result).toContain("cab")
    expect(result).not.toContain("apple")
  })

  test("best matches come first", () => {
    const result = fuzzySort("ab", items, (x) => x)
    // "abandon" starts with "ab" — best contiguous score
    expect(result[0]).toBe("abandon")
  })

  test("works with non-string items via getString", () => {
    const objs = [{ name: "alpha" }, { name: "beta" }, { name: "alphabet" }]
    const result = fuzzySort("alp", objs, (x) => x.name)
    expect(result.map((x) => x.name)).toEqual(["alpha", "alphabet"])
  })
})

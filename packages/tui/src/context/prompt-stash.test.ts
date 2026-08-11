import { describe, expect, test } from "bun:test"
import { parseStash } from "./prompt-stash"

describe("parseStash", () => {
  test("parses valid JSONL lines", () => {
    const text = `{"input":"hello","timestamp":"2026-01-01T00:00:00Z"}\n{"input":"world","timestamp":"2026-01-02T00:00:00Z"}`
    const entries = parseStash(text)
    expect(entries).toHaveLength(2)
    expect(entries[0].input).toBe("hello")
    expect(entries[1].input).toBe("world")
  })

  test("skips invalid JSON lines", () => {
    const text = `{"input":"valid","timestamp":"2026-01-01T00:00:00Z"}\ninvalid json\n{"input":"also","timestamp":"2026-01-02T00:00:00Z"}`
    const entries = parseStash(text)
    expect(entries).toHaveLength(2)
    expect(entries[0].input).toBe("valid")
    expect(entries[1].input).toBe("also")
  })

  test("skips empty lines", () => {
    const text = `\n{"input":"a","timestamp":"2026-01-01T00:00:00Z"}\n\n\n{"input":"b","timestamp":"2026-01-02T00:00:00Z"}\n`
    const entries = parseStash(text)
    expect(entries).toHaveLength(2)
  })

  test("parses entries with optional label", () => {
    const text = `{"input":"cmd","timestamp":"2026-01-01T00:00:00Z","label":"work"}`
    const entries = parseStash(text)
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe("work")
  })

  test("parses entries without label", () => {
    const text = `{"input":"cmd","timestamp":"2026-01-01T00:00:00Z"}`
    const entries = parseStash(text)
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBeUndefined()
  })

  test("returns empty array for empty string", () => {
    expect(parseStash("")).toEqual([])
  })

  test("returns empty array for whitespace-only string", () => {
    expect(parseStash("   \n  \t  ")).toEqual([])
  })

  test("truncates to max entries (50)", () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ input: `cmd-${i}`, timestamp: "2026-01-01T00:00:00Z" }),
    ).join("\n")
    const entries = parseStash(lines)
    expect(entries).toHaveLength(50)
    expect(entries[0].input).toBe("cmd-10")
    expect(entries[49].input).toBe("cmd-59")
  })
})

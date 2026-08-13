import { describe, expect, test } from "bun:test"
import {
  formatTimestamp,
  hasMarkdownSyntax,
  isCompactionSummaryText,
  parseCompactSummaryText,
  thinkingSummary,
  transcriptMessageIds,
} from "./transcript"

describe("hasMarkdownSyntax", () => {
  test("detects headings", () => {
    expect(hasMarkdownSyntax("# Title")).toBe(true)
    expect(hasMarkdownSyntax("## Subtitle")).toBe(true)
    expect(hasMarkdownSyntax("###### Deep heading")).toBe(true)
  })

  test("detects blockquotes", () => {
    expect(hasMarkdownSyntax("> Quote")).toBe(true)
  })

  test("detects list items", () => {
    expect(hasMarkdownSyntax("- item")).toBe(true)
    expect(hasMarkdownSyntax("* item")).toBe(true)
    expect(hasMarkdownSyntax("1. item")).toBe(true)
  })

  test("detects code blocks", () => {
    expect(hasMarkdownSyntax("```code```")).toBe(true)
  })

  test("detects bold", () => {
    expect(hasMarkdownSyntax("**bold**")).toBe(true)
  })

  test("detects inline code", () => {
    expect(hasMarkdownSyntax("`code`")).toBe(true)
  })

  test("detects links", () => {
    expect(hasMarkdownSyntax("[text](url)")).toBe(true)
  })

  test("returns false for plain text", () => {
    expect(hasMarkdownSyntax("Hello world")).toBe(false)
    expect(hasMarkdownSyntax("Just a sentence.")).toBe(false)
  })
})

describe("thinkingSummary", () => {
  test("returns first line", () => {
    expect(thinkingSummary("First line\nSecond line")).toBe("First line")
  })

  test("strips image markdown from first line", () => {
    expect(thinkingSummary("![alt](url) text")).toBe("alt text")
  })

  test("truncates to 60 chars with ellipsis", () => {
    const long = "a".repeat(80)
    const result = thinkingSummary(long)
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result.endsWith("...")).toBe(true)
  })

  test("returns short text unchanged", () => {
    expect(thinkingSummary("Short thinking")).toBe("Short thinking")
  })

  test("handles empty string", () => {
    expect(thinkingSummary("")).toBe("")
  })

  test("collapses whitespace", () => {
    expect(thinkingSummary("  hello   world  ")).toBe("hello world")
  })
})

describe("formatTimestamp", () => {
  test("formats valid ISO string as HH:MM", () => {
    const result = formatTimestamp("2026-01-15T14:30:00Z")
    expect(result).toMatch(/^\d{2}:\d{2}$/)
  })

  test("returns empty string for invalid date", () => {
    expect(formatTimestamp("not a date")).toBe("")
  })

  test("returns empty string for empty input", () => {
    expect(formatTimestamp("")).toBe("")
  })

  test("pads single digit hours and minutes", () => {
    const result = formatTimestamp("2026-01-15T09:05:00Z")
    expect(result).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe("transcriptMessageIds", () => {
  test("uses message ids as stable row identities", () => {
    expect(transcriptMessageIds([{ id: "msg_a" } as never, { id: "msg_b" } as never])).toEqual([
      "msg_a",
      "msg_b",
    ])
  })
})

describe("parseCompactSummaryText", () => {
  test("splits the legacy compact marker into notification and summary", () => {
    expect(
      parseCompactSummaryText("Compacted\n<compact-summary>## Summary</compact-summary>"),
    ).toEqual({
      notification: "Compacted",
      summary: "## Summary",
    })
  })

  test("rejects incomplete or ordinary text", () => {
    expect(parseCompactSummaryText("Compacted\n<compact-summary>incomplete")).toBeNull()
    expect(parseCompactSummaryText("ordinary assistant text")).toBeNull()
  })

  test("detects marker-less compaction summaries by their standard header", () => {
    const text =
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request"
    expect(isCompactionSummaryText(text)).toBe(true)
    expect(parseCompactSummaryText(text)).toEqual({
      notification: "",
      summary: text.trim(),
    })
  })

  test("does not treat ordinary user messages as compaction summaries", () => {
    expect(isCompactionSummaryText("This session is being continued with a new task.")).toBe(false)
  })
})

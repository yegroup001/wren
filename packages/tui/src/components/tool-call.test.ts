import { describe, expect, test } from "bun:test"
import type { TuiTheme } from "../theme/themes"
import { DEFAULT_THEME } from "../theme/themes"
import {
  editStrings,
  extractAgentId,
  formatOutput,
  leftTruncate,
  outputLineCount,
  rightTruncate,
  statusColorKey,
  toolAccent,
  toolColorKey,
  toolDetail,
  toolIcon,
  toolTypeLabel,
} from "./tool-call"

const theme: TuiTheme = DEFAULT_THEME

describe("toolTypeLabel", () => {
  test("maps known tool names to labels", () => {
    expect(toolTypeLabel("bash")).toBe("Shell")
    expect(toolTypeLabel("Read")).toBe("Read")
    expect(toolTypeLabel("FileEditTool")).toBe("Edit")
    expect(toolTypeLabel("GlobTool")).toBe("Glob")
    expect(toolTypeLabel("websearch")).toBe("Web Search")
    expect(toolTypeLabel("todowrite")).toBe("Todos")
    expect(toolTypeLabel("agent")).toBe("Agent")
  })

  test("returns toolName for unknown tools", () => {
    expect(toolTypeLabel("CustomTool")).toBe("CustomTool")
  })

  test("is case-insensitive", () => {
    expect(toolTypeLabel("BASH")).toBe("Shell")
    expect(toolTypeLabel("Agent")).toBe("Agent")
  })

  test("Skill label includes skill name when available", () => {
    expect(toolTypeLabel("skill", { skill: "commit" })).toBe("Skill: commit")
    expect(toolTypeLabel("skill", { skillName: "review" })).toBe("Skill: review")
    expect(toolTypeLabel("skill", { skill_name: "plan" })).toBe("Skill: plan")
    expect(toolTypeLabel("skill", { name: "test" })).toBe("Skill: test")
  })

  test("Skill label falls back when no name field", () => {
    expect(toolTypeLabel("skill", {})).toBe("Skill")
    expect(toolTypeLabel("skill")).toBe("Skill")
  })
})

describe("statusColorKey", () => {
  test("maps each status to a color key", () => {
    expect(statusColorKey("pending")).toBe("textMuted")
    expect(statusColorKey("running")).toBe("warning")
    expect(statusColorKey("completed")).toBe("success")
    expect(statusColorKey("failed")).toBe("error")
  })
})

describe("toolColorKey", () => {
  test("maps bash to toolBash", () => {
    expect(toolColorKey("bash")).toBe("toolBash")
    expect(toolColorKey("bashtool")).toBe("toolBash")
  })

  test("maps read/glob/grep to toolRead", () => {
    expect(toolColorKey("read")).toBe("toolRead")
    expect(toolColorKey("glob")).toBe("toolRead")
    expect(toolColorKey("grep")).toBe("toolRead")
  })

  test("maps write/edit to toolWrite", () => {
    expect(toolColorKey("write")).toBe("toolWrite")
    expect(toolColorKey("edit")).toBe("toolWrite")
    expect(toolColorKey("notebookedit")).toBe("toolWrite")
  })

  test("maps web tools to toolWeb", () => {
    expect(toolColorKey("webfetch")).toBe("toolWeb")
    expect(toolColorKey("websearch")).toBe("toolWeb")
  })

  test("maps unknown to toolDefault", () => {
    expect(toolColorKey("CustomTool")).toBe("toolDefault")
  })

  test("is case-insensitive", () => {
    expect(toolColorKey("BASH")).toBe("toolBash")
    expect(toolColorKey("READ")).toBe("toolRead")
  })
})

describe("toolAccent", () => {
  test("uses status color for non-completed statuses", () => {
    expect(toolAccent(theme, "bash", "failed")).toBe(theme.error)
    expect(toolAccent(theme, "bash", "running")).toBe(theme.warning)
    expect(toolAccent(theme, "bash", "pending")).toBe(theme.textMuted)
  })

  test("uses tool color for completed status", () => {
    expect(toolAccent(theme, "bash", "completed")).toBe(theme.toolBash)
    expect(toolAccent(theme, "read", "completed")).toBe(theme.toolRead)
    expect(toolAccent(theme, "agent", "completed")).toBe(theme.toolAgent)
  })
})

describe("toolIcon", () => {
  test("returns $ for bash", () => {
    expect(toolIcon("bash")).toBe("$")
  })

  test("returns arrow for read", () => {
    expect(toolIcon("read")).toBe("\u2192")
  })

  test("returns gear for unknown tools", () => {
    expect(toolIcon("CustomTool")).toBe("\u2699")
  })

  test("is case-insensitive", () => {
    expect(toolIcon("BASH")).toBe("$")
  })
})

describe("toolDetail", () => {
  test("extracts command for bash", () => {
    expect(toolDetail("bash", { command: "ls -la" })).toBe("ls -la")
  })

  test("extracts file_path for read", () => {
    expect(toolDetail("read", { file_path: "/tmp/test.ts" })).toBe("/tmp/test.ts")
  })

  test("extracts path as fallback for read", () => {
    expect(toolDetail("read", { path: "/tmp/test.ts" })).toBe("/tmp/test.ts")
  })

  test("extracts url for webfetch", () => {
    expect(toolDetail("webfetch", { url: "https://example.com" })).toBe("https://example.com")
  })

  test("extracts query for websearch", () => {
    expect(toolDetail("websearch", { query: "test query" })).toBe("test query")
  })

  test("extracts pattern for glob", () => {
    expect(toolDetail("glob", { pattern: "*.ts" })).toBe("*.ts")
  })

  test("extracts agent_type for agent", () => {
    expect(toolDetail("agent", { agent_type: "explore" })).toBe("explore")
  })

  test("returns empty string for unknown tools", () => {
    expect(toolDetail("CustomTool", { foo: "bar" })).toBe("")
  })

  test("returns empty string for null input", () => {
    expect(toolDetail("bash", null)).toBe("")
  })
})

describe("editStrings", () => {
  test("extracts snake_case old/new strings", () => {
    expect(editStrings({ old_string: "a", new_string: "b" })).toEqual({
      oldString: "a",
      newString: "b",
    })
  })

  test("extracts camelCase old/new strings", () => {
    expect(editStrings({ oldString: "x", newString: "y" })).toEqual({
      oldString: "x",
      newString: "y",
    })
  })

  test("returns empty strings for missing or non-object input", () => {
    expect(editStrings({})).toEqual({ oldString: "", newString: "" })
    expect(editStrings(null)).toEqual({ oldString: "", newString: "" })
    expect(editStrings("not an object")).toEqual({ oldString: "", newString: "" })
  })
})

describe("formatOutput", () => {
  test("returns string as-is", () => {
    expect(formatOutput("hello")).toBe("hello")
  })

  test("stringifies objects", () => {
    const result = formatOutput({ a: 1 })
    expect(result).toContain('"a": 1')
  })

  test("returns empty string for null/undefined/number", () => {
    expect(formatOutput(null)).toBe("")
    expect(formatOutput(undefined)).toBe("")
    expect(formatOutput(42)).toBe("")
  })
})

describe("outputLineCount", () => {
  test("counts single line", () => {
    expect(outputLineCount("hello")).toBe(1)
  })

  test("counts multiple lines", () => {
    expect(outputLineCount("line1\nline2\nline3")).toBe(3)
  })

  test("returns 0 for empty string", () => {
    expect(outputLineCount("")).toBe(0)
  })
})

describe("leftTruncate", () => {
  test("returns text unchanged when within limit", () => {
    expect(leftTruncate("hello", 10)).toBe("hello")
  })

  test("truncates from left with ellipsis", () => {
    const result = leftTruncate("abcdefghij", 5)
    expect(result).toBe("\u2026ghij")
    expect(result.length).toBe(5)
  })
})

describe("rightTruncate", () => {
  test("returns text unchanged when within limit", () => {
    expect(rightTruncate("hello", 10)).toBe("hello")
  })

  test("truncates from right with ellipsis", () => {
    const result = rightTruncate("abcdefghij", 5)
    expect(result).toBe("abcd\u2026")
    expect(result.length).toBe(5)
  })
})

describe("extractAgentId", () => {
  test("extracts from string output", () => {
    expect(extractAgentId("agentId: abc123")).toBe("abc123")
  })

  test("extracts from array of content blocks", () => {
    const output = [{ type: "text", text: "agentId: xyz789" }]
    expect(extractAgentId(output)).toBe("xyz789")
  })

  test("returns undefined when no agentId found", () => {
    expect(extractAgentId("no agent id here")).toBeUndefined()
    expect(extractAgentId("")).toBeUndefined()
  })

  test("returns undefined for non-string non-array", () => {
    expect(extractAgentId(42)).toBeUndefined()
    expect(extractAgentId(null)).toBeUndefined()
  })

  test("handles array without text blocks", () => {
    expect(extractAgentId([{ type: "image", text: "nope" }])).toBeUndefined()
  })
})

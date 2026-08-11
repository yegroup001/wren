import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRoot } from "solid-js"

async function waitForEntries(
  history: { entries: () => Array<unknown> },
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (history.entries().length > 0) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("waitForEntries timed out")
}

// append() persists fire-and-forget; poll the file instead of sleeping so the
// assertion can't race the async write under parallel test load.
async function waitForFileContent(file: string, content: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  const { readFileSync } = await import("node:fs")
  while (Date.now() - start < timeoutMs) {
    try {
      if (readFileSync(file, "utf-8").includes(content)) return
    } catch {
      // file may not exist yet
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for history file to contain: ${content}`)
}

import {
  createPromptHistory,
  isDuplicate,
  MAX_HISTORY_ENTRIES,
  parseHistory,
} from "./prompt-history"

describe("parseHistory", () => {
  test("parses valid JSONL lines", () => {
    const text = `{"input":"hello","timestamp":"2026-01-01T00:00:00Z"}\n{"input":"world","timestamp":"2026-01-02T00:00:00Z"}`
    const entries = parseHistory(text)
    expect(entries).toHaveLength(2)
    expect(entries[0].input).toBe("hello")
    expect(entries[1].input).toBe("world")
  })

  test("skips invalid JSON lines", () => {
    const text = `{"input":"hello","timestamp":"2026-01-01T00:00:00Z"}\nnot json\n{"input":"world","timestamp":"2026-01-02T00:00:00Z"}`
    const entries = parseHistory(text)
    expect(entries).toHaveLength(2)
    expect(entries[0].input).toBe("hello")
    expect(entries[1].input).toBe("world")
  })

  test("skips empty lines", () => {
    const text = `\n{"input":"a","timestamp":"2026-01-01T00:00:00Z"}\n\n\n{"input":"b","timestamp":"2026-01-02T00:00:00Z"}\n`
    const entries = parseHistory(text)
    expect(entries).toHaveLength(2)
  })

  test("truncates to MAX_HISTORY_ENTRIES", () => {
    const lines = Array.from({ length: MAX_HISTORY_ENTRIES + 10 }, (_, i) =>
      JSON.stringify({ input: `cmd-${i}`, timestamp: "2026-01-01T00:00:00Z" }),
    ).join("\n")
    const entries = parseHistory(lines)
    expect(entries).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(entries[0].input).toBe(`cmd-10`)
    expect(entries[entries.length - 1].input).toBe(`cmd-${MAX_HISTORY_ENTRIES + 9}`)
  })
})

describe("isDuplicate", () => {
  test("returns true when inputs match", () => {
    expect(isDuplicate({ input: "abc", timestamp: "" }, { input: "abc", timestamp: "" })).toBe(true)
  })

  test("returns false when inputs differ", () => {
    expect(isDuplicate({ input: "abc", timestamp: "" }, { input: "xyz", timestamp: "" })).toBe(
      false,
    )
  })

  test("returns false when prev is undefined", () => {
    expect(isDuplicate(undefined, { input: "abc", timestamp: "" })).toBe(false)
  })
})

describe("createPromptHistory", () => {
  const tmpDir = join(tmpdir(), `wren-test-${process.pid}`)
  const historyFile = join(tmpDir, "history.jsonl")

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("loads entries from file", async () => {
    const text = `{"input":"loaded","timestamp":"2026-01-01T00:00:00Z"}\n{"input":"loaded2","timestamp":"2026-01-02T00:00:00Z"}`
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      // Wait for async load
      await waitForEntries(history)
      expect(history.entries()).toHaveLength(2)
      expect(history.entries()[0].input).toBe("loaded")
      dispose()
    })
  })

  test("move up navigates to last entry", async () => {
    const text = `{"input":"first","timestamp":"2026-01-01T00:00:00Z"}\n{"input":"second","timestamp":"2026-01-02T00:00:00Z"}`
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await waitForEntries(history)
      const result = history.move("up", "draft")
      expect(result).toBe("second")
      dispose()
    })
  })

  test("move down returns to draft", async () => {
    const text = `{"input":"first","timestamp":"2026-01-01T00:00:00Z"}`
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await waitForEntries(history)
      history.move("up", "my draft")
      const result = history.move("down", "irrelevant")
      expect(result).toBe("my draft")
      dispose()
    })
  })

  test("append adds new entry and persists", async () => {
    writeFileSync(historyFile, "", "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await new Promise((r) => setTimeout(r, 50))
      await history.append("new command")
      expect(history.entries()).toHaveLength(1)
      expect(history.entries()[0].input).toBe("new command")
      dispose()
    })

    // Wait for async persist to complete (polling — the write is fire-and-forget)
    await waitForFileContent(historyFile, "new command")
  })

  test("append skips empty input", async () => {
    writeFileSync(historyFile, "", "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await new Promise((r) => setTimeout(r, 100))
      await history.append("   ")
      expect(history.entries()).toHaveLength(0)
      dispose()
    })
  })

  test("append skips duplicate of last entry", async () => {
    const text = `{"input":"dup","timestamp":"2026-01-01T00:00:00Z"}`
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await new Promise((r) => setTimeout(r, 50))
      await history.append("dup")
      expect(history.entries()).toHaveLength(1)
      dispose()
    })
  })

  test("search filters entries by substring", async () => {
    const text = [
      `{"input":"npm install","timestamp":"2026-01-01T00:00:00Z"}`,
      `{"input":"git commit","timestamp":"2026-01-02T00:00:00Z"}`,
      `{"input":"npm run build","timestamp":"2026-01-03T00:00:00Z"}`,
    ].join("\n")
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await waitForEntries(history)
      const results = history.search("npm")
      expect(results).toHaveLength(2)
      // Most recent first (reversed)
      expect(results[0].input).toBe("npm run build")
      expect(results[1].input).toBe("npm install")
      dispose()
    })
  })

  test("search returns empty for empty query", async () => {
    const text = `{"input":"test","timestamp":"2026-01-01T00:00:00Z"}`
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await new Promise((r) => setTimeout(r, 50))
      expect(history.search("")).toEqual([])
      dispose()
    })
  })

  test("reset clears cursor", async () => {
    const text = `{"input":"first","timestamp":"2026-01-01T00:00:00Z"}`
    writeFileSync(historyFile, text, "utf-8")

    await createRoot(async (dispose) => {
      const history = createPromptHistory(historyFile)
      await new Promise((r) => setTimeout(r, 50))
      history.move("up", "draft")
      history.reset()
      // After reset, move down should return undefined (cursor at -1)
      const result = history.move("down", "irrelevant")
      expect(result).toBeUndefined()
      dispose()
    })
  })
})

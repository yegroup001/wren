import { describe, expect, test } from "bun:test"
import {
  buildPreview,
  isBinaryContent,
  looksLikeFilePath,
  PASTE_PREVIEW_CHARS,
  PASTE_SUMMARY_CHARS,
  PASTE_SUMMARY_LINES,
  resolveFilePath,
} from "./prompt-paste"

describe("looksLikeFilePath", () => {
  test("recognizes absolute paths", () => {
    expect(looksLikeFilePath("/home/user/file.txt")).toBe(true)
    expect(looksLikeFilePath("/tmp/test.ts")).toBe(true)
  })

  test("recognizes home-relative paths", () => {
    expect(looksLikeFilePath("~/documents/file.md")).toBe(true)
  })

  test("recognizes relative paths", () => {
    expect(looksLikeFilePath("./src/index.ts")).toBe(true)
    expect(looksLikeFilePath("../lib/utils.ts")).toBe(true)
  })

  test("recognizes file:// URIs", () => {
    expect(looksLikeFilePath("file:///home/user/file.txt")).toBe(true)
  })

  test("rejects multiline text", () => {
    expect(looksLikeFilePath("/path/to\nfile")).toBe(false)
  })

  test("rejects plain words", () => {
    expect(looksLikeFilePath("hello")).toBe(false)
    expect(looksLikeFilePath("example.com")).toBe(false)
  })

  test("rejects URLs", () => {
    expect(looksLikeFilePath("https://example.com")).toBe(false)
    expect(looksLikeFilePath("http://localhost:3000")).toBe(false)
    expect(looksLikeFilePath("ftp://server/file")).toBe(false)
  })

  test("rejects quoted paths", () => {
    // looksLikeFilePath checks the raw text — quotes are stripped later in resolveFilePath
    // But the raw text starts with a quote, not a path prefix
    expect(looksLikeFilePath('"/home/user/file.txt"')).toBe(false)
  })
})

describe("resolveFilePath", () => {
  test("resolves absolute paths", () => {
    expect(resolveFilePath("/home/user/file.txt")).toBe("/home/user/file.txt")
  })

  test("resolves relative paths to cwd", () => {
    const resolved = resolveFilePath("./src/index.ts")
    expect(resolved).toContain("src/index.ts")
  })

  test("strips surrounding quotes", () => {
    expect(resolveFilePath('"/home/user/file.txt"')).toBe("/home/user/file.txt")
    expect(resolveFilePath("'/home/user/file.txt'")).toBe("/home/user/file.txt")
  })

  test("resolves file:// URIs", () => {
    expect(resolveFilePath("file:///home/user/file.txt")).toBe("/home/user/file.txt")
  })

  test("resolves ~/ to home directory", () => {
    const resolved = resolveFilePath("~/documents/file.md")
    expect(resolved).toContain("documents/file.md")
  })
})

describe("isBinaryContent", () => {
  test("returns true for content with null bytes", () => {
    expect(isBinaryContent("text\0binary")).toBe(true)
  })

  test("returns false for plain text", () => {
    expect(isBinaryContent("hello world")).toBe(false)
    expect(isBinaryContent("import { x } from 'y'\n")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isBinaryContent("")).toBe(false)
  })
})

describe("buildPreview", () => {
  test("returns empty string for whitespace-only content", () => {
    expect(buildPreview("   \n  \t  ")).toBe("")
    expect(buildPreview("")).toBe("")
  })

  test("returns full content when within preview length", () => {
    const short = "hello world"
    expect(buildPreview(short)).toBe(` — ${short}`)
  })

  test("truncates with ellipsis when exceeding preview length", () => {
    const long = "a".repeat(PASTE_PREVIEW_CHARS + 50)
    const result = buildPreview(long)
    expect(result.startsWith(" — ")).toBe(true)
    expect(result.endsWith("…")).toBe(true)
    expect(result.length).toBeLessThan(long.length + 10)
  })

  test("collapses whitespace", () => {
    expect(buildPreview("  hello   world  ")).toBe(" — hello world")
    expect(buildPreview("line1\nline2\ttabbed")).toBe(" — line1 line2 tabbed")
  })

  test("returns exactly PASTE_PREVIEW_CHARS of content", () => {
    const exact = "a".repeat(PASTE_PREVIEW_CHARS)
    expect(buildPreview(exact)).toBe(` — ${exact}`)
  })
})

describe("constants", () => {
  test("PASTE_PREVIEW_CHARS is 100", () => {
    expect(PASTE_PREVIEW_CHARS).toBe(100)
  })

  test("PASTE_SUMMARY_LINES is 3", () => {
    expect(PASTE_SUMMARY_LINES).toBe(3)
  })

  test("PASTE_SUMMARY_CHARS is 150", () => {
    expect(PASTE_SUMMARY_CHARS).toBe(150)
  })
})

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getEmptyToolPermissionContext } from "../../Tool"
import { extractGlobBaseDirectory, glob } from "../glob"

describe("extractGlobBaseDirectory", () => {
  test("extracts base dir from glob with *", () => {
    const result = extractGlobBaseDirectory("src/utils/*.ts")
    expect(result.baseDir).toBe("src/utils")
    expect(result.relativePattern).toBe("*.ts")
  })

  test("extracts base dir from glob with **", () => {
    const result = extractGlobBaseDirectory("src/**/*.ts")
    expect(result.baseDir).toBe("src")
    expect(result.relativePattern).toBe("**/*.ts")
  })

  test("returns dirname for literal path", () => {
    const result = extractGlobBaseDirectory("src/utils/file.ts")
    expect(result.baseDir).toBe("src/utils")
    expect(result.relativePattern).toBe("file.ts")
  })

  test("handles glob starting with pattern", () => {
    const result = extractGlobBaseDirectory("*.ts")
    expect(result.baseDir).toBe("")
    expect(result.relativePattern).toBe("*.ts")
  })

  test("handles braces pattern", () => {
    const result = extractGlobBaseDirectory("src/{a,b}/*.ts")
    expect(result.baseDir).toBe("src")
    expect(result.relativePattern).toBe("{a,b}/*.ts")
  })

  test("filters sensitive and explicit-ask files from broad plan searches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wren-plan-glob-"))
    const sshDirectory = join(directory, ".ssh")
    mkdirSync(sshDirectory)
    writeFileSync(join(directory, "src.ts"), "export const value = 1")
    writeFileSync(join(directory, ".env"), "TOKEN=secret")
    writeFileSync(join(directory, "id_rsa"), "private key")
    writeFileSync(join(directory, "CREDENTIALS.JSON"), "uppercase secret")
    writeFileSync(join(directory, "private.txt"), "ask first")
    writeFileSync(join(sshDirectory, "config"), "Host example")

    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      mode: "plan" as const,
      alwaysAskRules: { session: ["Read(private.txt)"] },
    }

    try {
      const result = await glob(
        "**/*",
        directory,
        { limit: 100, offset: 0 },
        new AbortController().signal,
        permissionContext,
      )
      const relativeFiles = result.files.map((file) => file.slice(directory.length + 1))

      expect(relativeFiles).toContain("src.ts")
      expect(relativeFiles).not.toContain(".env")
      expect(relativeFiles).not.toContain("id_rsa")
      expect(relativeFiles).not.toContain("CREDENTIALS.JSON")
      expect(relativeFiles).not.toContain("private.txt")
      expect(relativeFiles).not.toContain(join(".ssh", "config"))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

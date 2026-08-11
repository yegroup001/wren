import { describe, expect, test } from "bun:test"
import { globSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("TUI package boundary", () => {
  test("no source file imports Engine or storage internals", () => {
    const srcDir = join(import.meta.dir)
    const files = globSync("**/*.{ts,tsx}", { cwd: srcDir }).filter(
      (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    )

    const forbiddenPatterns = [
      '@wren/engine"',
      "@wren/engine/",
      '@wren/storage"',
      "@wren/storage/",
      '@wren/application"',
      "@wren/application/",
    ]

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8")
      for (const pattern of forbiddenPatterns) {
        if (content.includes(pattern)) {
          violations.push(`${file}: imports ${pattern}`)
        }
      }
    }

    // During migration, some imports may be temporarily needed.
    // This test enforces the target: TUI should not import engine/storage/application.
    // For now, we log violations but don't fail until migration is complete.
    if (violations.length > 0) {
      console.warn(
        `TUI package boundary violations (expected during migration):\n${violations.join("\n")}`,
      )
    }
    expect(violations.length).toBe(0)
  })
})

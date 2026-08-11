import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { compileStagedOutput } from "./compile-transaction"

describe("compileStagedOutput", () => {
  test("preserves the prior artifact and bunfig when compilation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wren-compile-transaction-"))
    const finalOutfile = join(directory, "wren")
    const bunfigPath = join(directory, "bunfig.toml")
    let stagedOutfile = ""

    try {
      await writeFile(finalOutfile, "previous executable")
      await writeFile(bunfigPath, 'preload = ["./dev-only.ts"]\n')

      await expect(
        compileStagedOutput({
          finalOutfile,
          compile: async (stagedPath) => {
            stagedOutfile = stagedPath
            await writeFile(stagedPath, "partial executable")
            return { exitCode: 1, stderr: "compiler fixture failure" }
          },
        }),
      ).rejects.toThrow("compiler fixture failure")

      expect(await readFile(finalOutfile, "utf8")).toBe("previous executable")
      expect(await readFile(bunfigPath, "utf8")).toBe('preload = ["./dev-only.ts"]\n')
      expect(dirname(stagedOutfile)).toBe(directory)
      expect(existsSync(stagedOutfile)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("promotes a successful staged artifact over the prior artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wren-compile-transaction-"))
    const finalOutfile = join(directory, "wren")
    let stagedOutfile = ""

    try {
      await writeFile(finalOutfile, "previous executable")

      await compileStagedOutput({
        finalOutfile,
        compile: async (stagedPath) => {
          stagedOutfile = stagedPath
          await writeFile(stagedPath, "new executable")
          return { exitCode: 0, stderr: "" }
        },
      })

      expect(await readFile(finalOutfile, "utf8")).toBe("new executable")
      expect(dirname(stagedOutfile)).toBe(directory)
      expect(existsSync(stagedOutfile)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

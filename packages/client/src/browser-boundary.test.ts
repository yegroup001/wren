import { describe, expect, test } from "bun:test"
import { globSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("client package browser safety", () => {
  test("no source file imports Node built-in modules", () => {
    const srcDir = join(import.meta.dir)
    const files = globSync("*.ts", { cwd: srcDir }).filter((f) => !f.endsWith(".test.ts"))

    const nodeBuiltins = [
      '"node:fs"',
      '"node:path"',
      '"node:os"',
      '"node:crypto"',
      '"node:child_process"',
      '"node:net"',
      '"node:http"',
      '"node:https"',
      '"node:url"',
      '"node:stream"',
      '"node:buffer"',
      '"node:process"',
      '"node:util"',
      '"node:events"',
      '"node:worker_threads"',
      '"node:tls"',
      '"node:dns"',
      '"node:vm"',
      '"fs"',
      '"path"',
      '"os"',
      '"crypto"',
    ]

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8")
      for (const builtin of nodeBuiltins) {
        const fromPattern = `from ${builtin}`
        const requirePattern = `require(${builtin})`
        if (content.includes(fromPattern) || content.includes(requirePattern)) {
          violations.push(`${file}: imports ${builtin}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

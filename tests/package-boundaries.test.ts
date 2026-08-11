import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "node:fs"

type Rule = {
  readonly package: string
  readonly forbidden: readonly string[]
  readonly allowInTests?: boolean
  readonly srcDir?: string
  // Files exempt from the forbidden-import scan (e.g. the in-process
  // transport in @wren/client, which legitimately depends on @wren/application).
  readonly excludeFiles?: readonly string[]
}

const RULES: readonly Rule[] = [
  {
    package: "protocol",
    forbidden: [
      "@wren/config-node",
      "@wren/engine",
      "@wren/storage",
      "@wren/adapter",
      "@wren/application",
      "@wren/tui",
      "solid-js",
      "@opentui",
    ],
    allowInTests: false,
  },
  {
    package: "client",
    forbidden: [
      "@wren/config-node",
      "@wren/engine",
      "@wren/storage",
      "@wren/adapter",
      "@wren/application",
      "@wren/tui",
      "solid-js",
      "@opentui",
    ],
    allowInTests: true, // conformance.ts uses bun:test (not a forbidden import)
    // in-process.ts is the opt-in transport: it calls WrenApplication directly
    // and so must depend on @wren/application (transitively engine/storage).
    excludeFiles: ["in-process.ts"],
  },
  {
    package: "config-node",
    forbidden: [
      "@wren/engine",
      "@wren/storage",
      "@wren/adapter",
      "@wren/application",
      "@wren/tui",
      "solid-js",
      "@opentui",
    ],
    allowInTests: false,
  },
  {
    package: "application",
    forbidden: [
      "@wren/config-node", // application uses config ports, not config-node directly
      "@wren/client",
      "@wren/adapter",
      "@wren/tui",
      "solid-js",
      "@opentui",
    ],
    allowInTests: false,
  },
  {
    package: "tui",
    forbidden: ["@wren/engine", "@wren/storage", "@wren/application"],
    allowInTests: true, // test files may import from adapter
  },
  {
    // Engine is the runtime core: it owns tools, permissions, and sessions.
    // It must not reach up into transport, application, client, or UI layers.
    package: "engine",
    forbidden: ["@wren/tui", "@wren/adapter", "@wren/application", "@wren/client"],
    allowInTests: false,
  },
  {
    // Concrete tool implementations live in engine/src/tools. They must
    // stay headless — no UI, application, or persistence coupling.
    package: "engine/src/tools",
    forbidden: [
      "@wren/tui",
      "@wren/application",
      "@wren/storage",
      "solid-js",
      "@opentui",
    ],
    allowInTests: false,
    srcDir: "packages/engine/src/tools",
  },
]

// Packages that were removed during the refactor must never be referenced again.
const DELETED_PACKAGES = [
  "@wren/shared",
  "@wren/agent-tools",
  "@wren/builtin-tools",
  "@wren/client-node",
] as const

function checkPackage(rule: Rule): string[] {
  const srcDir = join(process.cwd(), rule.srcDir ?? "packages", rule.package, "src")
  let files: string[]
  try {
    files = globSync("**/*.{ts,tsx}", { cwd: srcDir })
  } catch {
    return [] // package doesn't exist yet
  }

  const violations: string[] = []
  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
      if (rule.allowInTests === true) continue
    }
    if (rule.excludeFiles?.includes(file)) continue
    const content = readFileSync(join(srcDir, file), "utf8")
    for (const forbidden of rule.forbidden) {
      const patterns = [`from "${forbidden}"`, `from "${forbidden}/`]
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          violations.push(`${rule.package}/src/${file}: imports ${forbidden}`)
        }
      }
    }
  }
  return violations
}

describe("package boundary enforcement", () => {
  for (const rule of RULES) {
    test(`${rule.package} has no forbidden imports`, () => {
      const violations = checkPackage(rule)
      if (violations.length > 0) {
        console.warn(`Package boundary violations in ${rule.package}:\n${violations.join("\n")}`)
      }
      expect(violations).toEqual([])
    })
  }

  test("no source file references a removed package", () => {
    const violations: string[] = []
    for (const dir of ["packages", "apps"]) {
      const root = join(process.cwd(), dir)
      let entries: string[]
      try {
        entries = globSync("**/*.{ts,tsx}", { cwd: root })
      } catch {
        continue
      }
      for (const file of entries) {
        if (file.includes("/dist/")) continue
        const content = readFileSync(join(root, file), "utf8")
        for (const deleted of DELETED_PACKAGES) {
          if (content.includes(`"${deleted}`) || content.includes(`'${deleted}`)) {
            violations.push(`${dir}/${file}: references removed package ${deleted}`)
          }
        }
      }
    }
    if (violations.length > 0) {
      console.warn(`Removed package references:\n${violations.join("\n")}`)
    }
    expect(violations).toEqual([])
  }, 30_000)
})

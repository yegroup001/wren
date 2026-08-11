import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { z } from "zod"

const PackEntrySchema = z.object({
  name: z.literal("wren"),
  files: z.array(z.object({ path: z.string() })),
})

const PackOutputSchema = z
  .record(z.string(), PackEntrySchema)
  .refine((packages) => Object.keys(packages).length > 0, {
    message: "npm pack --dry-run --json returned no packages",
  })

const WrenPackOutputSchema = z.object({ wren: PackEntrySchema })

const forbiddenPathFragments = [".git/", ".github/", ".omo/", "node_modules/", ".env"] as const
// Real API keys and secrets are typically 20+ chars; documentation
// placeholders like "your-key" (8 chars) must not trigger false positives.
// Word boundary (\b) prevents matching "sk-" inside words like "task-notification".
// Vendored source is excluded — it contains regex patterns that mention
// secret formats (e.g. secretScanner.ts), not raw secrets.
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /(?:SECRET|TOKEN|PASSWORD|API_KEY)=[A-Za-z0-9_-]{20,}/,
]

const engineSourcePrefixes = [
  "packages/engine/src/",
  "packages/model-provider/src/",
]

const PACK_TIMEOUT_MS = 60_000

const packPromise = (async () => {
  const child = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  const packages = PackOutputSchema.parse(JSON.parse(stdout))
  return WrenPackOutputSchema.parse(packages).wren
})()

async function getPackFiles(): Promise<readonly string[]> {
  const pack = await packPromise
  return pack.files.map((file) => file.path)
}

describe("release artifact inspection", () => {
  test(
    "npm pack dry run contains only intended files",
    async () => {
      // Given: the package file whitelist in package.json.
      const files = await getPackFiles()

      // When: npm calculates the release artifact contents.

      // Then: local metadata, dependency folders, and runtime state are excluded.
      expect(files.length).toBeGreaterThan(0)
      for (const fragment of forbiddenPathFragments) {
        expect(files.some((file) => file.includes(fragment))).toBe(false)
      }
      expect(files).toContain("README.md")
      expect(files).toContain("THIRD_PARTY_NOTICES.md")
      expect(files).toContain("bunfig.toml")
      expect(files).toContain("config/follow-redirects-shim.ts")
    },
    PACK_TIMEOUT_MS,
  )

  test(
    "packaged artifact includes engine source",
    async () => {
      // Given: the dry-run artifact file list.
      const files = await getPackFiles()

      // Then: the extracted QueryEngine source is included.
      expect(files.some((f) => f.startsWith("packages/engine/src/"))).toBe(true)
      expect(files.some((f) => f.includes("QueryEngine"))).toBe(true)
    },
    PACK_TIMEOUT_MS,
  )

  test(
    "packaged artifact includes TUI and adapter source",
    async () => {
      // Given: the dry-run artifact file list.
      const files = await getPackFiles()

      // Then: our TUI and adapter source files are included.
      expect(files.some((f) => f.startsWith("packages/tui/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/adapter/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/protocol/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/config-node/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/storage/src/"))).toBe(true)
    },
    PACK_TIMEOUT_MS,
  )

  test(
    "packaged artifact includes new architecture packages",
    async () => {
      // Given: the dry-run artifact file list.
      const files = await getPackFiles()

      // Then: the new package sources are included.
      expect(files.some((f) => f.startsWith("packages/protocol/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/config-node/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/client/src/"))).toBe(true)
      expect(files.some((f) => f.startsWith("packages/application/src/"))).toBe(true)
    },
    PACK_TIMEOUT_MS,
  )

  test(
    "packaged text files contain no raw secret-looking values",
    async () => {
      // Given: the dry-run artifact file list.
      const files = await getPackFiles()

      // When: packaged text files are scanned.
      const findings = await secretFindings(files)

      // Then: no raw API keys, tokens, or passwords are present.
      expect(findings).toEqual([])
    },
    PACK_TIMEOUT_MS,
  )

  test("README contains project name and description", async () => {
    const readme = await readFile("README.md", "utf8")
    const normalized = readme.toLowerCase()
    expect(normalized).toContain("wren")
    expect(normalized).toContain("terminal-based ai coding agent")
  })
})

async function secretFindings(files: readonly string[]): Promise<readonly string[]> {
  const findings: string[] = []
  for (const file of files.filter(isScannableTextFile)) {
    if (engineSourcePrefixes.some((prefix) => file.startsWith(prefix))) continue
    const text = await readFile(file, "utf8")
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) findings.push(file)
    }
  }
  return findings
}

function isScannableTextFile(file: string): boolean {
  return /\.(?:json|md|ts|tsx|txt)$/.test(file)
}

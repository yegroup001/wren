/**
 * Package release binaries into per-platform tarballs for GitHub Releases.
 *
 * For each binary in dist/release/ (wren-{platform}, or wren-win32-x64.exe)
 * produces dist/release/wren-{platform}.tar.gz containing a single `wren`
 * (or `wren.exe`) executable at the archive root, matching what install.sh
 * expects.
 *
 * Usage:
 *   bun run scripts/package-release.ts                       # package all
 *   bun run scripts/package-release.ts --target=linux-x64    # package one
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const RELEASE_DIR = join(REPO_ROOT, "dist", "release")

const targetArg = process.argv.find((a) => a.startsWith("--target="))
const requestedTarget = targetArg?.slice("--target=".length)

const PLATFORM_RE = /^wren-(.+?)(\.exe)?$/

const entries = readdirSync(RELEASE_DIR)
  .filter((name) => PLATFORM_RE.test(name))
  .filter((name) => !name.endsWith(".tar.gz"))
  .filter((name) => {
    if (!requestedTarget) return true
    const m = name.match(PLATFORM_RE)
    return m?.[1] === requestedTarget
  })
  .sort()

if (entries.length === 0) {
  console.error(`No release binaries found in ${RELEASE_DIR}`)
  console.error("Run scripts/build-release.ts first.")
  process.exit(1)
}

const results: { name: string; size: string }[] = []

for (const entry of entries) {
  const binaryPath = join(RELEASE_DIR, entry)
  if (!statSync(binaryPath).isFile()) continue

  const isWindows = entry.endsWith(".exe")
  const innerName = isWindows ? "wren.exe" : "wren"
  const archiveName = entry.replace(PLATFORM_RE, "wren-$1.tar.gz")

  const stage = mkdtempSync(join(tmpdir(), "wren-pkg-"))
  try {
    const { execFileSync } = await import("node:child_process")
    execFileSync("cp", [binaryPath, join(stage, innerName)])
    execFileSync("tar", ["-czf", join(RELEASE_DIR, archiveName), "-C", stage, innerName])
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }

  const size = `${(statSync(join(RELEASE_DIR, archiveName)).size / 1024 / 1024).toFixed(1)} MB`
  results.push({ name: archiveName, size })
  console.log(`  ${archiveName.padEnd(30)} ${size.padStart(10)}`)
}

console.log(`\nPackaged ${results.length} archives into ${RELEASE_DIR}`)

/**
 * Multi-platform release build orchestrator.
 *
 * Downloads the target platform's @opentui/core-* native module (Bun skips
 * cross-platform packages during install), symlinks it into node_modules,
 * runs compile.ts, then optionally UPX-compresses the result.
 *
 * Usage:
 *   bun run scripts/build-release.ts                          # build all targets
 *   bun run scripts/build-release.ts --target=darwin-arm64     # build one target
 *   bun run scripts/build-release.ts --no-upx                  # skip UPX compression
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")

type Target = {
  name: string
  bunTarget: string
  nativePackage: string
  outfile: string
}

// Read @opentui/core version from package.json
const pkg = await Bun.file(join(REPO_ROOT, "package.json")).json()
const opentuiVersion: string | undefined = pkg.dependencies?.["@opentui/core"]
if (!opentuiVersion) {
  console.error("Cannot find @opentui/core in package.json dependencies")
  process.exit(1)
}
const version = opentuiVersion.replace(/^[^0-9]/, "")

const TARGETS: Target[] = [
  {
    name: "linux-x64",
    bunTarget: "bun-linux-x64",
    nativePackage: "@opentui/core-linux-x64",
    outfile: "wren-linux-x64",
  },
  {
    name: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    nativePackage: "@opentui/core-linux-arm64",
    outfile: "wren-linux-arm64",
  },
  {
    name: "linux-x64-musl",
    bunTarget: "bun-linux-x64-musl",
    nativePackage: "@opentui/core-linux-x64-musl",
    outfile: "wren-linux-x64-musl",
  },
  {
    name: "linux-arm64-musl",
    bunTarget: "bun-linux-arm64-musl",
    nativePackage: "@opentui/core-linux-arm64-musl",
    outfile: "wren-linux-arm64-musl",
  },
  {
    name: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    nativePackage: "@opentui/core-darwin-x64",
    outfile: "wren-darwin-x64",
  },
  {
    name: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    nativePackage: "@opentui/core-darwin-arm64",
    outfile: "wren-darwin-arm64",
  },
  {
    name: "win32-x64",
    bunTarget: "bun-windows-x64",
    nativePackage: "@opentui/core-win32-x64",
    outfile: "wren-win32-x64.exe",
  },
]

// --- Parse CLI args ---
const targetArg = process.argv.find((a) => a.startsWith("--target="))
const noUpx = process.argv.includes("--no-upx")
const requestedTarget = targetArg?.slice("--target=".length)

const targets = requestedTarget
  ? TARGETS.filter(
      (t) =>
        t.name === requestedTarget ||
        t.bunTarget === requestedTarget ||
        t.bunTarget === `bun-${requestedTarget}`,
    )
  : TARGETS

if (targets.length === 0) {
  console.error(`Unknown target: ${requestedTarget}`)
  console.error(`Available: ${TARGETS.map((t) => t.name).join(", ")}`)
  process.exit(1)
}

const releaseDir = join(REPO_ROOT, "dist", "release")
mkdirSync(releaseDir, { recursive: true })

// --- Check UPX availability ---
let upxAvailable = false
if (!noUpx) {
  const check = Bun.spawnSync({ cmd: ["which", "upx"], stdout: "pipe", stderr: "pipe" })
  upxAvailable = check.exitCode === 0
  if (!upxAvailable) {
    console.warn("Warning: UPX not found. Binaries will not be compressed.")
    console.warn("Install UPX for ~50% size reduction:")
    console.warn(
      "  Arch: pacman -S upx  |  Debian: apt install upx-ucl  |  macOS: brew install upx",
    )
  }
}

// --- Native module cache ---
const nativeCacheDir = join(REPO_ROOT, "build", "native")
mkdirSync(nativeCacheDir, { recursive: true })

async function ensureNativePackage(pkgName: string): Promise<string> {
  const cacheKey = pkgName.replace("/", "+")
  const cachePath = join(nativeCacheDir, `${cacheKey}@${version}`)

  if (existsSync(join(cachePath, "package.json"))) {
    return cachePath
  }

  console.log(`  Downloading ${pkgName}@${version}...`)
  rmSync(cachePath, { recursive: true, force: true })
  mkdirSync(cachePath, { recursive: true })

  const packProc = Bun.spawn({
    cmd: ["npm", "pack", `${pkgName}@${version}`, "--pack-destination", nativeCacheDir],
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO_ROOT,
  })
  const [exitCode, stderr] = await Promise.all([
    packProc.exited,
    new Response(packProc.stderr).text(),
  ])
  if (exitCode !== 0) {
    console.error(`npm pack failed for ${pkgName}: ${stderr}`)
    process.exit(1)
  }

  // npm pack outputs the tarball filename; find it and extract
  const stdoutText = await new Response(packProc.stdout).text()
  const tarballName = stdoutText.trim().split("\n").pop()
  if (!tarballName) {
    console.error(`npm pack produced no output for ${pkgName}`)
    process.exit(1)
  }
  const tarballPath = join(nativeCacheDir, tarballName)

  const extractProc = Bun.spawn({
    cmd: ["tar", "xzf", tarballPath, "-C", cachePath, "--strip-components=1"],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [extractExit, extractErr] = await Promise.all([
    extractProc.exited,
    new Response(extractProc.stderr).text(),
  ])
  if (extractExit !== 0) {
    console.error(`tar extract failed: ${extractErr}`)
    process.exit(1)
  }
  rmSync(tarballPath, { force: true })

  return cachePath
}

function setupSymlink(
  pkgName: string,
  realPath: string,
): { linkPath: string; originalTarget: string | null } {
  const linkPath = join(REPO_ROOT, "node_modules", pkgName)
  let originalTarget: string | null = null
  if (lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    originalTarget = readlinkSync(linkPath)
  }
  rmSync(linkPath, { force: true, recursive: true })
  symlinkSync(realPath, linkPath)
  return { linkPath, originalTarget }
}

function cleanupSymlink(pkgName: string, originalTarget: string | null): void {
  const linkPath = join(REPO_ROOT, "node_modules", pkgName)
  rmSync(linkPath, { force: true, recursive: true })
  if (originalTarget) {
    symlinkSync(originalTarget, linkPath)
  }
}

async function upxCompress(binaryPath: string): Promise<void> {
  console.log("  UPX compressing...")
  const proc = Bun.spawn({
    cmd: ["upx", "--best", "--lzma", binaryPath],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode] = await Promise.all([proc.exited])
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    console.warn(`  UPX failed (continuing uncompressed): ${stderr.trim()}`)
  }
}

function nativePackagesFor(pkgName: string): string[] {
  if (!pkgName.startsWith("@opentui/core-linux-")) return [pkgName]
  const glibcPackage = pkgName.replace(/-musl$/, "")
  return [glibcPackage, `${glibcPackage}-musl`]
}

function installedPackagePath(pkgName: string): string {
  return join(REPO_ROOT, "node_modules", pkgName)
}

// --- Build loop ---
const results: { target: string; path: string; size: string; compressed: boolean }[] = []

for (const target of targets) {
  console.log(`\n=== Building ${target.name} ===`)

  const symlinkInfos: { pkgName: string; originalTarget: string | null }[] = []

  // OpenTUI's Linux loader resolves both libc variants while bundling, even
  // though the compiled target only embeds the selected runtime variant.
  for (const pkgName of nativePackagesFor(target.nativePackage)) {
    if (existsSync(join(installedPackagePath(pkgName), "package.json"))) continue
    const nativePath = await ensureNativePackage(pkgName)
    const { originalTarget } = setupSymlink(pkgName, nativePath)
    symlinkInfos.push({ pkgName, originalTarget })
  }

  try {
    const outfile = join(releaseDir, target.outfile)
    const compileProc = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        join(REPO_ROOT, "apps/cli/compile.ts"),
        `--target=${target.bunTarget}`,
        `--outfile=${outfile}`,
      ],
      stdout: "inherit",
      stderr: "inherit",
      cwd: REPO_ROOT,
    })
    const exitCode = await compileProc.exited
    if (exitCode !== 0) {
      console.error(`Build failed for ${target.name}`)
      process.exit(1)
    }

    let compressed = false
    if (upxAvailable) {
      await upxCompress(outfile)
      compressed = true
    }

    const size = Bun.file(outfile).size
    results.push({
      target: target.name,
      path: outfile.replace(`${REPO_ROOT}/`, ""),
      size: `${(size / 1024 / 1024).toFixed(1)} MB`,
      compressed,
    })
  } finally {
    for (const { pkgName, originalTarget } of symlinkInfos) {
      cleanupSymlink(pkgName, originalTarget)
    }
  }
}

// --- Summary ---
console.log("\n=== Build Summary ===")
for (const r of results) {
  const tag = r.compressed ? " (UPX)" : ""
  console.log(`  ${r.target.padEnd(20)} ${r.size.padStart(10)}  ${r.path}${tag}`)
}

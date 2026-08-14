/**
 * Sync version from root package.json to all workspace packages.
 *
 * Usage:
 *   bun run scripts/sync-version.ts              # read root, sync to all
 *   bun run scripts/sync-version.ts 0.2.0        # set root to 0.2.0, sync
 */
import { readFileSync, writeFileSync } from "node:fs"
import { globSync } from "node:fs"
import { spawnSync } from "node:child_process"

const root = JSON.parse(readFileSync("package.json", "utf8"))

const newVersion = process.argv[2]
if (newVersion) {
  root.version = newVersion
  writeFileSync("package.json", JSON.stringify(root, null, 2) + "\n")
  console.log(`Root: ${newVersion}`)
} else {
  console.log(`Root: ${root.version}`)
}

for (const pattern of ["packages/*/package.json", "apps/*/package.json"]) {
  for (const file of globSync(pattern)) {
    const pkg = JSON.parse(readFileSync(file, "utf8"))
    if (pkg.version !== root.version) {
      pkg.version = root.version
      writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
      console.log(`  ${pkg.name}: ${pkg.version}`)
    }
  }
}

const result = spawnSync("bun", ["install"], { stdio: "inherit" })
if (result.status !== 0) process.exit(1)

console.log("Done.")

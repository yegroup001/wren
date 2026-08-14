import { existsSync } from "node:fs"
import { join } from "node:path"

// serve.ts embeds apps/web/dist via ?raw imports — ensure the assets exist
// before bundling the CLI.
const webDist = join(import.meta.dir, "..", "web", "dist")
if (!existsSync(join(webDist, "index.html"))) {
  const webBuild = Bun.spawnSync({
    cmd: ["bun", "run", join(import.meta.dir, "..", "web", "build.ts")],
    stdout: "inherit",
    stderr: "inherit",
  })
  if (!webBuild.success) process.exit(1)
}

const WORKSPACE_EXTERNALS = [
  "@wren/engine",
  "@wren/adapter",
  "@wren/protocol",
  "@wren/storage",
  "@wren/tui",
  "@wren/model-provider",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
  "solid-js/store",
  "zod",
  "fflate",
  "sharp",
]

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  target: "bun",
  external: WORKSPACE_EXTERNALS,
})

if (!result.success) {
  for (const log of result.logs) {
    console.error("build:", log.message ?? log)
  }
  process.exit(1)
}

for (const output of result.outputs) {
  console.log(`${output.path}  ${output.size} bytes`)
}

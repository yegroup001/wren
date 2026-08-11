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

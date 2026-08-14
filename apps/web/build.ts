import { rename } from "node:fs/promises"
import { join } from "node:path"
// @ts-expect-error - No bundled types for @babel/core; used only at build time.
import { transformAsync } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"

/**
 * SolidJS JSX transform for the web app. Uses babel-preset-solid with
 * generate: "dom" (imports the DOM runtime from solid-js/web) — the
 * @opentui/solid bun-plugin is hardcoded to generate: "universal" for the
 * terminal renderer and cannot be reused here.
 */
const solidTransformPlugin: Bun.BunPlugin = {
  name: "wren-web-solid",
  setup(build) {
    build.onLoad({ filter: /\.(tsx|jsx)$/ }, async (args) => {
      if (args.path.includes("/node_modules/")) return undefined
      const code = await Bun.file(args.path).text()
      const transformed = await transformAsync(code, {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [[solid, { generate: "dom" }], [ts]],
      })
      return { contents: transformed?.code ?? code, loader: "js" }
    })
  },
}

const root = import.meta.dir
const outdir = join(root, "dist")

const watch = process.argv.includes("--watch")

const result = await Bun.build({
  entrypoints: [join(root, "src/main.tsx")],
  outdir,
  target: "browser",
  minify: true,
  plugins: [solidTransformPlugin],
  naming: {
    entry: "[name].[ext]",
    asset: "[name].[ext]",
  },
  ...(watch ? { watch: true } : {}),
})

if (!result.success) {
  for (const log of result.logs) {
    console.error("build:", log.message ?? String(log))
  }
  process.exit(1)
}

// The CSS asset is named after the entrypoint ("main.css"); the server and
// index.html reference a fixed /style.css path.
const generatedCss = join(outdir, "main.css")
if (await Bun.file(generatedCss).exists()) {
  await rename(generatedCss, join(outdir, "style.css"))
}

await Bun.write(
  join(outdir, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wren</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="app"></div>
<script src="/main.js"></script>
</body>
</html>
`,
)

console.log(`web build done: ${outdir}`)

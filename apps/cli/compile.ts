/**
 * Compile Wren into a standalone binary.
 *
 * Single-pass: Bun.build() with the `compile` option bundles, transforms,
 * and compiles in one step. Bun handles native module embedding
 * (@opentui/core-* .so/.dylib/.dll) and SolidJS transform automatically.
 *
 * zod is pre-bundled with esbuild before the main build to work around a
 * Bun.Build linker bug that breaks zod v4's internal namespace imports
 * (import * as util from "./util.js") when inlined into a single file.
 *
 * A compile plugin stubs non-essential packages (unused vendor SDKs,
 * NAPI modules) that wren doesn't need at runtime but would otherwise
 * fail to resolve during bundling.
 *
 * Usage:
 *   bun run apps/cli/compile.ts                              # → ./dist/release/wren
 *   bun run apps/cli/compile.ts --outfile=dist/wren
 *   bun run apps/cli/compile.ts --target=bun-darwin-arm64 --outfile=dist/release/wren-darwin-arm64
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { compileStagedOutput, StandaloneCompileError } from "./src/compile-transaction"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..", "..")

// --- Parse CLI args ---
const outfileArg = process.argv.find((a) => a.startsWith("--outfile="))
const targetArg = process.argv.find((a) => a.startsWith("--target="))

const bunTarget = (targetArg?.slice("--target=".length) ??
  "bun-linux-x64") as Bun.Build.CompileTarget
const requestedOutfile = outfileArg?.slice("--outfile=".length) ?? join("dist", "release", "wren")
const finalOutfile = resolve(REPO_ROOT, requestedOutfile)

mkdirSync(dirname(finalOutfile), { recursive: true })

const ENGINE_SRC = join(REPO_ROOT, "packages/engine/src")
const MODEL_PROVIDER = join(REPO_ROOT, "packages/model-provider/src")
const STUB_NAMESPACE = "wren-tsx-stub"
const ZOD_NAMESPACE = "wren-zod-prebundled"

// --- Pre-bundle zod with esbuild ---
// Bun.Build's linker breaks zod v4's `import * as util from "./util.js"`
// namespace imports when inlining all modules into one file. esbuild handles
// this correctly, so we pre-bundle zod into a single ESM module and redirect
// all zod/zod/v4 imports to it via a bun plugin.
console.log("Pre-bundling zod with esbuild...")
const zodEntryDir = mkdtempSync(join(__dirname, ".zod-prebundle-"))
const zodEntryFile = join(zodEntryDir, "entry.ts")
const zodBundleFile = join(zodEntryDir, "zod-bundled.mjs")
writeFileSync(zodEntryFile, `export * from "zod/v4";\nexport { default } from "zod/v4";\n`)

const { build: esbuildBuild } = await import("esbuild")
await esbuildBuild({
  entryPoints: [zodEntryFile],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: zodBundleFile,
  target: "esnext",
  legalComments: "none",
})
console.log(`  zod bundled: ${(statSync(zodBundleFile).size / 1024).toFixed(0)} KB`)

const zodBundleContents = await Bun.file(zodBundleFile).text()

// Clean up temp dir
rmSync(zodEntryDir, { recursive: true, force: true })

function mapAlias(spec: string): { dir: string; inner: string } | null {
  if (spec === "src") return { dir: ENGINE_SRC, inner: "./index" }
  if (spec.startsWith("src/")) return { dir: ENGINE_SRC, inner: `./${spec.slice(4)}` }
  if (spec === "@wren/model-provider") return { dir: MODEL_PROVIDER, inner: "./index" }
  if (spec.startsWith("@wren/model-provider/"))
    return { dir: MODEL_PROVIDER, inner: `./${spec.slice("@wren/model-provider/".length)}` }
  return null
}

// CJS stub for non-essential packages that would otherwise fail to resolve.
const STUB_CONTENTS = `
const noop = function() { return noopProxy; };
const handler = {
  get(_t, p) {
    if (p === "__esModule") return true;
    if (p === "default") return noopProxy;
    if (p === "then") return undefined;
    if (p === Symbol.toPrimitive) return () => "stub";
    if (p === Symbol.iterator) return function* () {};
    if (typeof p === "symbol") return undefined;
    return noopProxy;
  },
  ownKeys() {
    return ["length","name","prototype","SandboxManager","default","__esModule",
            "SandboxRuntimeConfigSchema","SandboxViolationStore",
            "AGENT_TOOL_NAME","TASK_OUTPUT_TOOL_NAME","TASK_STOP_TOOL_NAME",
            "BashTool","version","create","read","write","delete","exists",
            "list","get","set","remove","update"];
  },
  getOwnPropertyDescriptor(_t, p) {
    return { enumerable: true, configurable: true, value: noopProxy };
  },
  has() { return true; },
  construct() { return noopProxy; },
  apply() { return noopProxy; },
};
var noopProxy = new Proxy(noop, handler);
module.exports = noopProxy;
`

function stripExt(p: string): string {
  return p.replace(/\.(m?js|tsx?|json)$/, "")
}

function findReal(dir: string, spec: string): string | null {
  const base = stripExt(join(dir, spec))
  const exts = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]
  for (const e of exts) {
    const p = base + e
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  for (const e of exts) {
    const p = join(base, `index${e}`)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

// Non-essential packages: unused vendor SDKs, NAPI modules, etc.
// @opentui/core-* are NOT stubbed — bun's compile embeds the correct
// platform native module automatically.
const NONESSENTIAL_FILTER =
  /^(@anthropic-ai\/(bedrock|claude-agent|mcpb|sandbox-runtime|foundry|vertex)|@aws-sdk\/|google-auth-library$|url-handler-napi$|modifiers-napi$|audio-capture-napi$|doubaoime-asr$|@ant\/(claude-for-chrome-mcp|computer-use-)|^sharp$|@alcalzone\/ansi-tokenize|^follow-redirects$|^turndown$|^detect-libc$|^@smithy\/|^@azure\/|^react$|^react-dom$|^react-jsx$|^ink$|^@inkjs\/|^fflate$)/

const stubPlugin: Bun.BunPlugin = {
  name: "wren-stub",
  setup(build) {
    // 0. Redirect zod/zod/v4 to esbuild pre-bundle
    build.onResolve({ filter: /^zod(\/v4)?$/ }, () => ({
      path: "zod-prebundled",
      namespace: ZOD_NAMESPACE,
    }))

    build.onResolve({ filter: NONESSENTIAL_FILTER }, () => {
      return { path: "wren-tsx-stub-module", namespace: STUB_NAMESPACE }
    })

    // 2. Stub workspace alias imports (src/*, @wren/model-provider) that have no real file
    build.onResolve({ filter: /^(src\/|src$|@wren\/model-provider)/ }, (args) => {
      if (args.importer.includes("/node_modules/")) return undefined
      const alias = mapAlias(args.path)
      if (!alias) return undefined
      const realPath = findReal(alias.dir, alias.inner)
      if (realPath !== null) return undefined
      return { path: "wren-tsx-stub-module", namespace: STUB_NAMESPACE }
    })

    // 3. Catch-all: stub any remaining unresolved relative paths in workspace source
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (args.importer.includes("/node_modules/")) return undefined
      if (!args.resolveDir.includes("/packages/")) return undefined
      const realPath = findReal(args.resolveDir, args.path)
      if (realPath !== null) return undefined
      return { path: "wren-tsx-stub-module", namespace: STUB_NAMESPACE }
    })

    build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({
      contents: STUB_CONTENTS,
      loader: "js",
    }))

    build.onLoad({ filter: /.*/, namespace: ZOD_NAMESPACE }, () => ({
      contents: zodBundleContents,
      loader: "js",
    }))
  },
}

// follow-redirects shim
const followRedirectsShim = `
(function(){
var _origCaptureStackTrace = Error.captureStackTrace;
if (typeof _origCaptureStackTrace === "function") {
  Error.captureStackTrace = function(target, constructor) {
    try { _origCaptureStackTrace.call(this, target, constructor); } catch (e) {}
  };
}
})();
`

console.log(`Compiling (target=${bunTarget})...`)

try {
  await compileStagedOutput({
    finalOutfile,
    compile: async (stagedOutfile) => {
      const result = await Bun.build({
        entrypoints: [join(__dirname, "src", "main.ts")],
        plugins: [createSolidTransformPlugin(), stubPlugin],
        external: [],
        minify: true,
        banner: followRedirectsShim,
        compile: {
          autoloadBunfig: false,
          autoloadDotenv: false,
          target: bunTarget,
          outfile: stagedOutfile,
        },
      })

      if (!result.success) {
        return {
          exitCode: 1,
          stderr: result.logs.map((l) => l.message ?? String(l)).join("\n"),
        }
      }

      // Bun appends .exe for Windows targets — normalize so compileStagedOutput finds it
      if (!existsSync(stagedOutfile) && existsSync(`${stagedOutfile}.exe`)) {
        renameSync(`${stagedOutfile}.exe`, stagedOutfile)
      }

      return { exitCode: 0, stderr: "" }
    },
  })
} catch (error) {
  if (error instanceof StandaloneCompileError) {
    console.error("compile failed:")
    console.error(error.stderr)
    process.exit(1)
  }
  throw error
}

const finalSize = Bun.file(finalOutfile).size
const sizeMB = (finalSize / 1024 / 1024).toFixed(1)
console.log(`\nStandalone binary: ${finalOutfile} (${sizeMB} MB)`)
console.log(
  `Test with: ./${finalOutfile.replace(`${REPO_ROOT}/`, "")} /tmp/test-project --prompt "hello"`,
)

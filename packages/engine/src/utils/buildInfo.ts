/**
 * Build metadata — replacement for vendored MACRO globals.
 *
 * Previously injected as compile-time constants via `VERSION` etc.
 * Now read from package.json at module load. compile.ts can still override
 * via process.env if needed.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

function readVersion(): string {
  try {
    // Walk up from engine/src/utils/ to root package.json
    const pkgPath = join(__dirname, "..", "..", "..", "..", "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

export const VERSION = process.env.WREN_VERSION ?? readVersion()
export const BUILD_TIME = process.env.WREN_BUILD_TIME ?? undefined
export const PACKAGE_URL = "wren"
export const NATIVE_PACKAGE_URL = "wren"

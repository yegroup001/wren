import { join } from "node:path"
import type { WebAssets } from "./serve"

/**
 * Dev/runtime path: read the built web assets from disk. compile.ts replaces
 * this module with an inline version so standalone binaries embed the assets
 * without a filesystem.
 */
export async function loadWebAssets(): Promise<WebAssets> {
  const dist = join(import.meta.dir, "..", "..", "web", "dist")
  return {
    html: await Bun.file(join(dist, "index.html")).text(),
    js: await Bun.file(join(dist, "main.js")).text(),
    css: await Bun.file(join(dist, "style.css")).text(),
  }
}

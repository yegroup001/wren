import { Buffer } from "node:buffer"
import { isInBundledMode } from "src/utils/bundledMode.js"

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: { compressionLevel?: number; palette?: boolean; colors?: number }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // Try to load the native image processor first
    try {
      // Use the native image processor module
      const imageProcessor = await import("image-processor-napi")
      const sharpFn = (imageProcessor.sharp ?? imageProcessor.default) as
        | SharpFunction
        | null
        | undefined
      // The napi wrapper exports null when sharp isn't installed, and the
      // bun-stub plugin substitutes a no-op Proxy (truthy but not a real
      // factory) in compiled binaries. Both must fall through to the real
      // sharp import below instead of being cached as a silent no-op.
      if (typeof sharpFn === "function" && isUsableSharp(sharpFn)) {
        imageProcessorModule = { default: sharpFn }
        return sharpFn
      }
    } catch {
      // Fall back to sharp if native module is not available
      console.warn("Native image processor not available, falling back to sharp")
    }
  }

  // Use sharp for non-bundled builds or as fallback.
  // Single structural cast: our SharpFunction is a subset of sharp's actual type surface.
  let sharp: SharpFunction
  try {
    const imported = (await import("sharp")) as unknown as MaybeDefault<SharpFunction>
    sharp = unwrapDefault(imported)
  } catch {
    throw new Error("No image processor available: neither native module nor sharp is installed")
  }
  if (!isUsableSharp(sharp)) {
    throw new Error("No image processor available: neither native module nor sharp is installed")
  }
  imageProcessorModule = { default: sharp }
  return sharp
}

// Real sharp factories return a chainable instance object; the stub Proxy's
// apply() returns undefined. Probing with a 1x1 PNG is side-effect free
// (sharp validates input lazily — an empty buffer would throw).
const ONE_PX_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62000100000500010d0a2db40000000049454e44ae426082",
  "hex",
)
function isUsableSharp(factory: SharpFunction): boolean {
  try {
    const instance = factory(ONE_PX_PNG) as unknown
    return instance !== null && typeof instance === "object"
  } catch {
    return false
  }
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  let sharp: SharpCreator
  try {
    const imported = (await import("sharp")) as unknown as MaybeDefault<SharpCreator>
    sharp = unwrapDefault(imported)
  } catch {
    throw new Error("No image processor available: neither native module nor sharp is installed")
  }
  if (!isUsableSharp(sharp as unknown as SharpFunction)) {
    throw new Error("No image processor available: neither native module nor sharp is installed")
  }
  imageCreatorModule = { default: sharp }
  return sharp
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(mod: MaybeDefault<T>): T {
  return typeof mod === "function" ? mod : mod.default
}

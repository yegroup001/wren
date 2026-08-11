import type { WriteFileOptions } from "fs"
import { closeSync, writeFileSync as fsWriteFileSync, fsyncSync, openSync } from "fs"
import lodashCloneDeep from "lodash-es/cloneDeep.js"

// Extended WriteFileOptions to include 'flush' which is available in Node.js 20.1.0+
// but not yet in @types/node
type WriteFileOptionsWithFlush = WriteFileOptions | (WriteFileOptions & { flush?: boolean })

// --- Slow operation logging infrastructure ---

/**
 * Threshold in milliseconds for logging slow JSON/clone operations.
 * Operations taking longer than this will be logged for debugging.
 * - Dev builds: 20ms (lower threshold for development)
 * - Production: Infinity (disabled)
 */
const SLOW_OPERATION_THRESHOLD_MS = (() => {
  if (process.env.NODE_ENV === "development") {
    return 20
  }
  return Infinity
})()

// Re-export for callers that still need the threshold value directly
export { SLOW_OPERATION_THRESHOLD_MS }

const NOOP_LOGGER: Disposable = { [Symbol.dispose]() {} }

function slowLoggingExternal(): Disposable {
  return NOOP_LOGGER
}

/**
 * Tagged template for slow operation logging.
 *
 * Returns a singleton no-op disposable. Zero allocations, zero timing.
 *
 * @example
 * using _ = slowLogging`structuredClone(${value})`
 * const result = structuredClone(value)
 */
export const slowLogging: (strings: TemplateStringsArray, ...values: unknown[]) => Disposable =
  slowLoggingExternal

// --- Wrapped operations ---

/**
 * Wrapped JSON.stringify with slow operation logging.
 * Use this instead of JSON.stringify directly to detect performance issues.
 *
 * @example
 * import { jsonStringify } from './slowOperations.js'
 * const json = jsonStringify(data)
 * const prettyJson = jsonStringify(data, null, 2)
 */
export function jsonStringify(
  value: unknown,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: (number | string)[] | null,
  space?: string | number,
): string
export function jsonStringify(
  value: unknown,
  replacer?: ((this: unknown, key: string, value: unknown) => unknown) | (number | string)[] | null,
  space?: string | number,
): string {
  using _ = slowLogging`JSON.stringify(${value})`
  return JSON.stringify(value, replacer as Parameters<typeof JSON.stringify>[1], space)
}

/**
 * Wrapped JSON.parse with slow operation logging.
 * Use this instead of JSON.parse directly to detect performance issues.
 *
 * @example
 * import { jsonParse } from './slowOperations.js'
 * const data = jsonParse(jsonString)
 */
export const jsonParse: typeof JSON.parse = (text, reviver) => {
  using _ = slowLogging`JSON.parse(${text})`
  // V8 de-opts JSON.parse when a second argument is passed, even if undefined.
  // Branch explicitly so the common (no-reviver) path stays on the fast path.
  return typeof reviver === "undefined" ? JSON.parse(text) : JSON.parse(text, reviver)
}

/**
 * Wrapped structuredClone with slow operation logging.
 * Use this instead of structuredClone directly to detect performance issues.
 *
 * @example
 * import { clone } from './slowOperations.js'
 * const copy = clone(originalObject)
 */
export function clone<T>(value: T, options?: StructuredSerializeOptions): T {
  using _ = slowLogging`structuredClone(${value})`
  return structuredClone(value, options)
}

/**
 * Wrapped cloneDeep with slow operation logging.
 * Use this instead of lodash cloneDeep directly to detect performance issues.
 *
 * @example
 * import { cloneDeep } from './slowOperations.js'
 * const copy = cloneDeep(originalObject)
 */
export function cloneDeep<T>(value: T): T {
  using _ = slowLogging`cloneDeep(${value})`
  return lodashCloneDeep(value)
}

/**
 * Wrapper around fs.writeFileSync with slow operation logging.
 * Supports flush option to ensure data is written to disk before returning.
 * @param filePath The path to the file to write to
 * @param data The data to write (string or Buffer)
 * @param options Optional write options (encoding, mode, flag, flush)
 * @deprecated Use `fs.promises.writeFile` instead for non-blocking writes.
 * Sync file writes block the event loop and cause performance issues.
 */
export function writeFileSync_DEPRECATED(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: WriteFileOptionsWithFlush,
): void {
  using _ = slowLogging`fs.writeFileSync(${filePath}, ${data})`

  // Check if flush is requested (for object-style options)
  const needsFlush =
    options !== null && typeof options === "object" && "flush" in options && options.flush === true

  if (needsFlush) {
    // Manual flush: open file, write, fsync, close
    const encoding =
      typeof options === "object" && "encoding" in options ? options.encoding : undefined
    const mode = typeof options === "object" && "mode" in options ? options.mode : undefined
    let fd: number | undefined
    try {
      fd = openSync(filePath, "w", mode)
      fsWriteFileSync(fd, data, { encoding: encoding ?? undefined })
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  } else {
    // No flush needed, use standard writeFileSync
    fsWriteFileSync(filePath, data, options as WriteFileOptions)
  }
}

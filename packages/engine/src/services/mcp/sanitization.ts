// Unicode sanitization for MCP data
// Ported from engine's utils/sanitization.ts (the hardened version)

/**
 * Partially sanitize a single string by removing dangerous Unicode categories.
 * Uses iterative NFKC normalization and strips format/private-use/noncharacter ranges
 * to mitigate ASCII smuggling and hidden prompt injection attacks.
 *
 * Reference: HackerOne report #3086545
 */
export function partiallySanitizeUnicode(prompt: string): string {
  let current = prompt
  let previous = ""
  let iterations = 0
  const MAX_ITERATIONS = 10

  while (current !== previous && iterations < MAX_ITERATIONS) {
    previous = current
    current = current.normalize("NFKC")
    // Preserve the previous MCP sanitizer's control/replacement filtering in
    // addition to the hidden-Unicode protections below.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character sanitization
    current = current.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\uFFFD/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character sanitization
    current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    current = current
      .replace(/[\u200B-\u200F]/g, "")
      .replace(/[\u202A-\u202E]/g, "")
      .replace(/[\u2066-\u2069]/g, "")
      .replace(/[\uFEFF]/g, "")
      .replace(/[\uE000-\uF8FF]/g, "")
    iterations++
  }

  if (iterations >= MAX_ITERATIONS) {
    throw new Error(
      `Unicode sanitization reached maximum iterations (${MAX_ITERATIONS}) for input: ${prompt.slice(0, 100)}`,
    )
  }

  return current
}

export function recursivelySanitizeUnicode(value: string): string
export function recursivelySanitizeUnicode<T>(value: T[]): T[]
export function recursivelySanitizeUnicode<T extends object>(value: T): T
export function recursivelySanitizeUnicode<T>(value: T): T
export function recursivelySanitizeUnicode(value: unknown): unknown {
  if (typeof value === "string") {
    return partiallySanitizeUnicode(value)
  }

  if (Array.isArray(value)) {
    return value.map(recursivelySanitizeUnicode)
  }

  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = Object.create(null)
    for (const [key, val] of Object.entries(value)) {
      const sanitizedKey = recursivelySanitizeUnicode(key)
      if (sanitizedKey === "__proto__" || sanitizedKey === "constructor" || sanitizedKey === "prototype") {
        continue
      }
      Object.defineProperty(sanitized, sanitizedKey, {
        value: recursivelySanitizeUnicode(val),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return sanitized
  }

  return value
}

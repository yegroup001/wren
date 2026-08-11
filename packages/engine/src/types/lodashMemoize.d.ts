/**
 * Override lodash-es/memoize.js type to return a portable type.
 *
 * lodash's MemoizedFunction includes lodash-internal properties that can't
 * be named in .d.ts output without referencing @types/lodash, triggering
 * TS2742 across 60+ files when emitDeclarationOnly is true. This declaration
 * provides an equivalent type that is fully portable.
 *
 * Runtime: the real lodash-es memoize is used. Types: this declaration.
 */

interface MemoizedCache {
  clear(): void
  delete(key: unknown): boolean
  get(key: unknown): unknown
  has(key: unknown): boolean
  set(key: unknown, value: unknown): unknown
  size?: number
}

declare module "lodash-es/memoize.js" {
  type Memoized<T extends (...args: never[]) => unknown> = T & {
    cache: MemoizedCache
  }

  export function memoize<T extends (...args: never[]) => unknown>(
    fn: T,
    resolver?: (...args: Parameters<T>) => unknown,
  ): Memoized<T>

  export default memoize
}

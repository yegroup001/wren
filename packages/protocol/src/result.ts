export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function assertNever(value: never): never {
  throw new UnexpectedVariantError(String(value))
}

export class UnexpectedVariantError extends Error {
  readonly name = "UnexpectedVariantError"

  constructor(readonly value: string) {
    super(`unexpected variant: ${value}`)
  }
}

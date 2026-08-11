/**
 * Factory for a no-op replacement of `packages/engine/src/utils/errors.ts`,
 * used via `mock.module(..., errorsMock)` in tests that want to isolate
 * error-handling behavior. Mirrors the module's FULL export surface: any
 * consumer importing a missing named export fails at load time with
 * `SyntaxError: Export named 'X' not found`.
 */
export const errorsMock = () => ({
  ClaudeError: class ClaudeError extends Error {},
  MalformedCommandError: class MalformedCommandError extends Error {},
  AbortError: class AbortError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = "AbortError"
    }
  },
  isAbortError: (e: unknown) =>
    e instanceof Error && (e as Error).name === "AbortError",
  ConfigParseError: class ConfigParseError extends Error {},
  ShellError: class ShellError extends Error {},
  TeleportOperationError: class TeleportOperationError extends Error {},
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: class TelemetrySafeError extends Error {},
  hasExactErrorMessage: (): boolean => false,
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  errorMessage: (e: unknown): string => String(e),
  getErrnoCode: (): undefined => undefined,
  isENOENT: (): boolean => false,
  getErrnoPath: (): undefined => undefined,
  shortErrorStack: (): string => "",
  isFsInaccessible: (): boolean => false,
  classifyAxiosError: (): { category: string; kind?: string; status?: number; retryable?: boolean } => ({
    category: "unknown",
  }),
})

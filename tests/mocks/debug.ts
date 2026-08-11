/**
 * Factory for a no-op replacement of `packages/engine/src/utils/debug.ts`,
 * used via `mock.module(..., debugMock)` in tests that want to silence
 * engine debug logging. The mock must mirror the module's FULL export
 * surface: `mock.module` swaps the whole module, so any consumer importing
 * a missing named export fails at load time with
 * `SyntaxError: Export named 'X' not found`.
 */
export const debugMock = () => ({
  getMinDebugLogLevel: (): string => "error",
  isDebugMode: (): boolean => false,
  enableDebugLogging: (): boolean => false,
  getDebugFilter: (): null => null,
  isDebugToStdErr: (): boolean => false,
  getDebugFilePath: (): null => null,
  setHasFormattedOutput: (_value: boolean) => {},
  getHasFormattedOutput: (): boolean => false,
  flushDebugLogs: async (): Promise<void> => {},
  logForDebugging: (..._args: unknown[]) => {},
  getDebugLogPath: (): string => "",
  logAntError: (_context: string, _error: unknown) => {},
  registerDebugSkill: () => {},
})

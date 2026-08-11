/**
 * Factory for a no-op replacement of `src/utils/log.ts`, used via
 * `mock.module("src/utils/log.ts", logMock)` in tests that want to silence
 * engine logging. `mock.module` requires a function factory; the returned
 * object matches the named exports consumers import.
 */
export const logMock = () => ({
  attachErrorLogSink: (_sink: unknown) => {},
  dateToFilename: (_date: Date): string => "",
  captureAPIRequest: (..._args: unknown[]) => {},
  logError: (_error: unknown) => {},
  getInMemoryErrors: (): { error: string; timestamp: string }[] => [],
  logMCPDebug: (_serverName: string, _message: string) => {},
  logMCPError: (_serverName: string, _error: unknown) => {},
  getLogDisplayTitle: (_log: unknown, defaultTitle?: string): string => defaultTitle ?? "",
})

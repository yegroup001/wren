// Wren headless implementation: the upstream task/progress UI logic this
// module would provide was not carried over. Exports are minimal no-ops so
// the headless engine loads; the behavior they gate (async-agent progress,
// permission confirm UI, message selection) is intentionally degraded.
export const LocalShellTask = function (..._args: unknown[]) { return null; };
export const BACKGROUND_BASH_SUMMARY_PREFIX = function (..._args: unknown[]) { return null; };

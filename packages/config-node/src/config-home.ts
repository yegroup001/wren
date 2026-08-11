import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_CONFIG_HOME = join(homedir(), ".wren")

let _testOverride: string | undefined

/**
 * Resolve the user-level home directory for Wren.
 *
 * Always returns ~/.wren. Tests can override via
 * setWrenConfigHomeForTests() to point at a temp directory.
 */
export function getWrenConfigHome(): string {
  return (_testOverride ?? DEFAULT_CONFIG_HOME).normalize("NFC")
}

/**
 * Test-only override for the home directory.
 * Pass undefined to reset to the default.
 */
export function setWrenConfigHomeForTests(dir: string | undefined): void {
  _testOverride = dir
}

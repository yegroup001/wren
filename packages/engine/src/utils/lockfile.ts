/**
 * proper-lockfile wrapper.
 *
 * Re-exports lockfile functions from the `proper-lockfile` package.
 */

import * as lockfile from "proper-lockfile"
import type { CheckOptions, LockOptions, UnlockOptions } from "proper-lockfile"

export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>> {
  return lockfile.lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return lockfile.lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return lockfile.unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return lockfile.check(file, options)
}

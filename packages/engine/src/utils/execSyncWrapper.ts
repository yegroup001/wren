import {
  type ExecSyncOptions,
  type ExecSyncOptionsWithBufferEncoding,
  type ExecSyncOptionsWithStringEncoding,
  execSync as nodeExecSync,
} from "child_process"
import { slowLogging } from "./slowOperations.js"

/**
 * Wrapped execSync with slow operation logging.
 * Use this instead of child_process execSync directly to detect performance issues.
 *
 * @example
 * import { execSyncWrapper } from './execSyncWrapper.js'
 * const result = execSyncWrapper('git status', { encoding: 'utf8' })
 */
export function execSyncWrapper(command: string): Buffer
export function execSyncWrapper(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string
export function execSyncWrapper(
  command: string,
  options: ExecSyncOptionsWithBufferEncoding,
): Buffer
export function execSyncWrapper(command: string, options?: ExecSyncOptions): Buffer | string
export function execSyncWrapper(command: string, options?: ExecSyncOptions): Buffer | string {
  using _ = slowLogging`execSync: ${command.slice(0, 100)}`
  return nodeExecSync(command, options)
}

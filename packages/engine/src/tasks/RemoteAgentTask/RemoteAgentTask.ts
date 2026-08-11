import type { TaskStateBase } from '../../Task.js'

/**
 * State for remote agent tasks.
 * The full implementation is stubbed in headless mode — this type exists
 * so the TaskState discriminated union resolves correctly.
 */
export type RemoteAgentTaskState = TaskStateBase & {
  type: 'remote_agent'
  sessionUrl?: string
  error?: string
}

// Stub implementations — headless mode degrades remote agent functionality.
// Real logic lives in the upstream .tsx module that was not carried over.

export const checkRemoteAgentEligibility = function (..._args: unknown[]): null {
  return null
}
export const formatPreconditionError = function (..._args: unknown[]): null {
  return null
}
export const getRemoteTaskSessionUrl = function (..._args: unknown[]): null {
  return null
}
export const registerCompletionChecker = function (..._args: unknown[]): null {
  return null
}
export const registerCompletionHook = function (..._args: unknown[]): null {
  return null
}
export const registerContentExtractor = function (..._args: unknown[]): null {
  return null
}
export const registerRemoteAgentTask = function (..._args: unknown[]): null {
  return null
}
export type AutofixPrRemoteTaskMetadata = unknown
export type BackgroundRemoteSessionPrecondition = unknown
export const RemoteAgentTask = function (..._args: unknown[]): null {
  return null
}

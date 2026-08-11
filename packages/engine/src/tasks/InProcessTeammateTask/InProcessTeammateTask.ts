import type { TaskState } from '../types.js'
import type { InProcessTeammateTaskState } from './types.js'

/**
 * Find an in-process teammate task by its agent ID.
 * Searches through AppState.tasks for a matching InProcessTeammateTaskState.
 */
export function findTeammateTaskByAgentId(
  agentId: string,
  tasks: Record<string, TaskState>,
): InProcessTeammateTaskState | undefined {
  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.identity.agentId === agentId
    ) {
      return task
    }
  }
  return undefined
}

// Stub implementations — headless mode degrades teammate UI logic.
export const injectUserMessageToTeammate = function (..._args: unknown[]): null {
  return null
}
export const getRunningTeammatesSorted = function (..._args: unknown[]): null {
  return null
}
export const InProcessTeammateTask = function (..._args: unknown[]): null {
  return null
}
export const requestTeammateShutdown = function (..._args: unknown[]): null {
  return null
}
export const appendTeammateMessage = function (..._args: unknown[]): null {
  return null
}

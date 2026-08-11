import type { TaskStateBase } from '../../Task.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { AgentToolResult } from 'src/tools/AgentTool/agentToolUtils.js'
import type { Message } from '../../types/message.js'

/**
 * Progress tracking for async agent tasks.
 * Used by LocalAgentTaskState.progress and InProcessTeammateTaskState.progress.
 */
export type AgentProgress = {
  summary?: string
  tokenCount: number
  toolUseCount: number
  recentActivities?: Array<{
    toolName: string
    input: Record<string, unknown>
    activityDescription?: string
  }>
  lastActivity?: {
    activityDescription?: string
  }
}

/**
 * Internal tracker for accumulating progress during agent execution.
 * The stub implementation returns null; real tracking is degraded in headless mode.
 */
export type ProgressTracker = {
  tokenCount: number
  toolUseCount: number
  lastActivity?: { activityDescription?: string }
  recentActivities?: Array<{
    toolName: string
    input: Record<string, unknown>
    activityDescription?: string
  }>
}

/**
 * State for local (in-process) agent tasks.
 * Also used as the base for LocalMainSessionTaskState (Ctrl+B backgrounded sessions).
 */
export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'
  agentId: string
  prompt: string
  selectedAgent?: AgentDefinition
  abortController?: AbortController
  unregisterCleanup?: () => void
  retrieved: boolean
  lastReportedToolCount: number
  lastReportedTokenCount: number
  isBackgrounded: boolean
  pendingMessages: unknown[]
  retain: boolean
  diskLoaded: boolean
  messages?: Message[]
  progress?: AgentProgress
  error?: string
  result?: AgentToolResult
  evictAfter?: number
}

export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === "object" &&
    task !== null &&
    "type" in task &&
    task.type === "local_agent"
  )
}

// Stub implementations — headless mode degrades agent progress tracking.
// Real logic lives in the upstream .tsx module that was not carried over.

export const killAllRunningAgentTasks = (..._args: unknown[]): null => null
export const markAgentsNotified = (..._args: unknown[]): null => null
export const updateAgentSummary = (..._args: unknown[]): null => null
export const LocalAgentTask = (..._args: unknown[]): null => null
export const createActivityDescriptionResolver = (..._args: unknown[]): null => null
export const createProgressTracker = (..._args: unknown[]): ProgressTracker =>
  null as unknown as ProgressTracker
export const getProgressUpdate = (..._args: unknown[]): AgentProgress =>
  null as unknown as AgentProgress
export const updateProgressFromMessage = (..._args: unknown[]): void => {}
export const drainPendingMessages = (..._args: unknown[]): null => null
export const queuePendingMessage = (..._args: unknown[]): null => null
export const registerAsyncAgent = (opts?: {
  agentId?: string
  description?: string
  prompt?: string
  selectedAgent?: unknown
  setAppState?: unknown
  toolUseId?: string
}): { agentId: string; abortController: AbortController } => {
  return {
    agentId: opts?.agentId ?? "",
    abortController: new AbortController(),
  }
}
export const completeAgentTask = (..._args: unknown[]): null => null
export const enqueueAgentNotification = (..._args: unknown[]): null => null
export const failAgentTask = (..._args: unknown[]): null => null
export const getTokenCountFromTracker = (..._args: unknown[]): number => 0
export const killAsyncAgent = (..._args: unknown[]): null => null
export const updateAgentProgress = (..._args: unknown[]): null => null

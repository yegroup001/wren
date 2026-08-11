/**
 * Real engine core.
 *
 * The previous mock fixture engine (engine.ts, fixture-engine.ts,
 * session-factory.ts, events.ts) has been removed from src/ — the original
 * mock files are preserved in removed. The real
 * engine wrapper (`createWrenEngine`) instantiates the QueryEngine with
 * real tools, model selection, and a `canUseTool` bridge.
 *
 * The extracted source lives at the engine package root. The primary export
 * is the real `QueryEngine` extracted from the upstream source.
 */

export { setIsInteractive } from "../bootstrap/state.js"
export type {
  ModelUsage,
  PermissionMode,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKStatus,
  SDKSystemMessage,
  SDKUserMessage,
} from "../entrypoints/sdk/coreTypes.generated.js"
export type { QueryEngineConfig } from "../QueryEngine"
export { QueryEngine } from "../QueryEngine"
export {
  _setGoalFromPersistedState as hydrateGoalFromState,
  clearGoal,
  completeGoal,
  continueGoalFromMaxTurns,
  formatGoalElapsed,
  formatGoalStatusLabel,
  getGoal,
  incrementGoalTurns,
  MAX_GOAL_TURNS,
  markGoalMaxTurnsReached,
  pauseGoal,
  resumeGoal,
  setGoal,
} from "../services/goal/goalState.js"
export { persistCurrentGoal, persistGoalClear } from "../services/goal/goalStorage.js"
export { buildBudgetLimitPrompt, buildContinuationPrompt } from "../services/goal/prompts.js"
export type {
  WorkspaceMcpHostOptions,
  WorkspaceMcpSnapshot,
  WorkspaceMcpSnapshotListener,
} from "../services/mcp/workspace-host.js"
export {
  emptyWorkspaceMcpSnapshot,
  WorkspaceMcpHost,
} from "../services/mcp/workspace-host.js"
export type {
  LocalShellSpawnInput,
  Task,
  TaskContext,
  TaskHandle,
  TaskStatus,
  TaskType,
} from "../Task"
export { generateTaskId, isTerminalTaskStatus } from "../Task"
export type { CompactProgressEvent, Tools } from "../Tool.js"
export { getAllBaseTools, WREN_DEFAULT_TOOLS } from "../tools/index.js"
export { WREN_TOOL_CLASSIFICATIONS } from "./engine"
export type { ToolAllowlistEntry } from "@wren/protocol"

/* The default runtime tool names are defined in tools.ts. */
export {
  isSafeAgentId,
  loadEngineSessionMessages,
} from "../utils/sessionStorage.js"
export type { EngineSessionResume } from "../utils/sessionStorage.js"
export {
  mirrorEntryToSqlite,
  setEntryMirror,
  setTranscriptFileSink,
} from "../utils/sessionStorage.js"
export { closeTranscriptMirror, initTranscriptMirror } from "../storage/transcriptMirror.js"
export type { GoalState } from "../types/logs.js"
export {
  getConfig,
  getModelEffort,
  getModelFallbacks,
  getWrenConfigSafe,
  initConfig,
  setConfigForTests,
} from "../utils/model/configBridge.js"
export type {
  CreateWrenEngineOptions,
  McpSnapshotProvider,
  PermissionResolver,
  PermissionResolverContext,
  WrenEngine,
  WrenEngineFactory,
} from "./engine"
export { createWrenEngine, createWrenEngineFactory } from "./engine"
export { EngineHistoryOwnershipError, EngineHistorySnapshot } from "./history-snapshot"

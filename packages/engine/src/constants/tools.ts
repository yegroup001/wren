// biome-ignore-all assist/source/organizeImports: import markers must not be reordered
import { TASK_OUTPUT_TOOL_NAME } from "src/tools/TaskOutputTool/constants.js"
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from "src/tools/ExitPlanModeTool/constants.js"
import { ENTER_PLAN_MODE_TOOL_NAME } from "src/tools/EnterPlanModeTool/constants.js"
import { AGENT_TOOL_NAME } from "src/tools/AgentTool/constants.js"
import { ASK_USER_QUESTION_TOOL_NAME } from "src/tools/AskUserQuestionTool/prompt.js"
import { TASK_STOP_TOOL_NAME } from "src/tools/TaskStopTool/prompt.js"
import { FILE_READ_TOOL_NAME } from "src/tools/FileReadTool/prompt.js"
import { WEB_SEARCH_TOOL_NAME } from "src/tools/WebSearchTool/prompt.js"
import { TODO_WRITE_TOOL_NAME } from "src/tools/TodoWriteTool/constants.js"
import { GREP_TOOL_NAME } from "src/tools/GrepTool/prompt.js"
import { WEB_FETCH_TOOL_NAME } from "src/tools/WebFetchTool/prompt.js"
import { GLOB_TOOL_NAME } from "src/tools/GlobTool/prompt.js"
import { SHELL_TOOL_NAMES } from "../utils/shell/shellToolUtils.js"
import { FILE_EDIT_TOOL_NAME } from "src/tools/FileEditTool/constants.js"
import { FILE_WRITE_TOOL_NAME } from "src/tools/FileWriteTool/prompt.js"
import { NOTEBOOK_EDIT_TOOL_NAME } from "src/tools/NotebookEditTool/constants.js"
import { SKILL_TOOL_NAME } from "src/tools/SkillTool/constants.js"
import { SEND_MESSAGE_TOOL_NAME } from "src/tools/SendMessageTool/constants.js"
import { SEARCH_EXTRA_TOOLS_TOOL_NAME } from "src/tools/SearchExtraToolsTool/constants.js"
import { SYNTHETIC_OUTPUT_TOOL_NAME } from "src/tools/SyntheticOutputTool/SyntheticOutputTool.js"
import { SLEEP_TOOL_NAME } from "src/tools/SleepTool/prompt.js"
import { LSP_TOOL_NAME } from "src/tools/LSPTool/prompt.js"
import { VERIFY_PLAN_EXECUTION_TOOL_NAME } from "src/tools/VerifyPlanExecutionTool/constants.js"
import { TEAM_CREATE_TOOL_NAME } from "src/tools/TeamCreateTool/constants.js"
import { TEAM_DELETE_TOOL_NAME } from "src/tools/TeamDeleteTool/constants.js"
import { EXECUTE_TOOL_NAME } from "src/tools/ExecuteTool/constants.js"
import { ENTER_WORKTREE_TOOL_NAME } from "src/tools/EnterWorktreeTool/constants.js"
import { EXIT_WORKTREE_TOOL_NAME } from "src/tools/ExitWorktreeTool/constants.js"
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from "src/tools/ScheduleCronTool/prompt.js"
import { LOCAL_MEMORY_RECALL_TOOL_NAME } from "src/tools/LocalMemoryRecallTool/constants.js"
import { GOAL_TOOL_NAME } from "src/tools/GoalTool/constants.js"
import { VAULT_HTTP_FETCH_TOOL_NAME } from "src/tools/VaultHttpFetchTool/constants.js"

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // Agent tool is disallowed for all agents (prevents recursion)
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  // LOCAL-WIRING PR-1: keep local-memory recall on the main thread only.
  // Cross-session user notes shouldn't be siphoned by spawned subagents.
  // Layer 2 of the gate (fork path useExactTools) is enforced separately
  // by filterParentToolsForFork in src/utils/agentToolFilter.ts.
  LOCAL_MEMORY_RECALL_TOOL_NAME,
  // LOCAL-WIRING PR-2: vault HTTP fetch is even more sensitive (touches
  // user secrets). Same two-layer gate applies — keep main thread only.
  VAULT_HTTP_FETCH_TOOL_NAME,
])

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([...ALL_AGENT_DISALLOWED_TOOLS])

/*
 * Async Agent Tool Availability Status (Source of Truth)
 */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
  EXECUTE_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
/**
 * Tools allowed only for in-process teammates (not general async agents).
 * These are injected by inProcessRunner.ts and allowed through filterToolsForAgent
 * via isInProcessTeammate() check.
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  SEND_MESSAGE_TOOL_NAME,
  // Teammate-created crons are tagged with the creating agentId and routed to
  // that teammate's pendingUserMessages queue (see useScheduledTasks.ts).
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
])

/*
 * BLOCKED FOR ASYNC AGENTS:
 * - AgentTool: Blocked to prevent recursion
 * - TaskOutputTool: Blocked to prevent recursion
 * - ExitPlanModeTool: Plan mode is a main thread abstraction.
 * - TaskStopTool: Requires access to main thread task state.
 *
 * ENABLE LATER (NEED WORK):
 * - MCPTool: TBD
 * - ListMcpResourcesTool: TBD
 * - ReadMcpResourceTool: TBD
 */

/**
 * Tools allowed in coordinator mode - only output and agent management tools for the coordinator
 */
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

/**
 * Core tools that are always loaded with full schema at initialization.
 * These tools are never deferred — they appear in the initial prompt.
 * All other tools (non-core built-in + all MCP tools) are deferred
 * and must be discovered via SearchExtraToolsTool / ExecuteExtraTool.
 */
export const CORE_TOOLS = new Set([
  // File operations
  ...SHELL_TOOL_NAMES, // 'Bash', 'Shell'
  FILE_READ_TOOL_NAME, // 'Read'
  FILE_EDIT_TOOL_NAME, // 'Edit'
  FILE_WRITE_TOOL_NAME, // 'Write'
  GLOB_TOOL_NAME, // 'Glob'
  GREP_TOOL_NAME, // 'Grep'
  NOTEBOOK_EDIT_TOOL_NAME, // 'NotebookEdit'
  // Agent & interaction
  AGENT_TOOL_NAME, // 'Agent'
  ASK_USER_QUESTION_TOOL_NAME, // 'AskUserQuestion'
  // Task management
  TASK_OUTPUT_TOOL_NAME, // 'TaskOutput'
  TASK_STOP_TOOL_NAME, // 'TaskStop'
  TODO_WRITE_TOOL_NAME, // 'TodoWrite'
  // Planning
  ENTER_PLAN_MODE_TOOL_NAME, // 'EnterPlanMode'
  EXIT_PLAN_MODE_V2_TOOL_NAME, // 'ExitPlanMode'
  VERIFY_PLAN_EXECUTION_TOOL_NAME, // 'VerifyPlanExecution'
  GOAL_TOOL_NAME, // 'GoalTool'
  // Web
  WEB_FETCH_TOOL_NAME, // 'WebFetch'
  WEB_SEARCH_TOOL_NAME, // 'WebSearch'
  // Code intelligence
  LSP_TOOL_NAME, // 'LSP'
  // Skills
  SKILL_TOOL_NAME, // 'Skill'
  // Scheduling & monitoring
  SLEEP_TOOL_NAME, // 'Sleep'
  // Tool discovery (always loaded)
  SEARCH_EXTRA_TOOLS_TOOL_NAME, // 'SearchExtraTools'
  EXECUTE_TOOL_NAME, // 'ExecuteExtraTool'
  SYNTHETIC_OUTPUT_TOOL_NAME, // 'SyntheticOutput'
]) as ReadonlySet<string>

// biome-ignore-all assist/source/organizeImports: import markers must not be reordered
import { toolMatchesName, type Tool, type Tools } from "../Tool.js"
import { AgentTool } from "src/tools/AgentTool/AgentTool.js"
import { SkillTool } from "src/tools/SkillTool/SkillTool.js"
import { BashTool } from "src/tools/BashTool/BashTool.js"
import { FileEditTool } from "src/tools/FileEditTool/FileEditTool.js"
import { FileReadTool } from "src/tools/FileReadTool/FileReadTool.js"
import { FileWriteTool } from "src/tools/FileWriteTool/FileWriteTool.js"
import { GlobTool } from "src/tools/GlobTool/GlobTool.js"
import { NotebookEditTool } from "src/tools/NotebookEditTool/NotebookEditTool.js"
import { WebFetchTool } from "src/tools/WebFetchTool/WebFetchTool.js"
import { TaskStopTool } from "src/tools/TaskStopTool/TaskStopTool.js"
import { CronCreateTool } from "./ScheduleCronTool/CronCreateTool.js"
import { CronDeleteTool } from "./ScheduleCronTool/CronDeleteTool.js"
import { CronListTool } from "./ScheduleCronTool/CronListTool.js"
import { VerifyPlanExecutionTool } from "./VerifyPlanExecutionTool/VerifyPlanExecutionTool.js"
import { TaskOutputTool } from "src/tools/TaskOutputTool/TaskOutputTool.js"
import { WebSearchTool } from "src/tools/WebSearchTool/WebSearchTool.js"
import { TodoWriteTool } from "src/tools/TodoWriteTool/TodoWriteTool.js"
import { ExitPlanModeV2Tool } from "src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js"
import { GrepTool } from "src/tools/GrepTool/GrepTool.js"
import { TeamCreateTool } from "./TeamCreateTool/TeamCreateTool.js"
import { TeamDeleteTool } from "./TeamDeleteTool/TeamDeleteTool.js"
import { SendMessageTool } from "./SendMessageTool/SendMessageTool.js"
import { AskUserQuestionTool } from "src/tools/AskUserQuestionTool/AskUserQuestionTool.js"
import { LSPTool } from "src/tools/LSPTool/LSPTool.js"
import { ListMcpResourcesTool } from "src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js"
import { ReadMcpResourceTool } from "src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js"
import { SearchExtraToolsTool } from "src/tools/SearchExtraToolsTool/SearchExtraToolsTool.js"
import { ExecuteTool } from "src/tools/ExecuteTool/ExecuteTool.js"
import { EnterPlanModeTool } from "src/tools/EnterPlanModeTool/EnterPlanModeTool.js"
import { EnterWorktreeTool } from "src/tools/EnterWorktreeTool/EnterWorktreeTool.js"
import { ExitWorktreeTool } from "src/tools/ExitWorktreeTool/ExitWorktreeTool.js"
import { ConfigTool } from "src/tools/ConfigTool/ConfigTool.js"
import { GoalTool } from "src/tools/GoalTool/GoalTool.js"
import { LocalMemoryRecallTool } from "src/tools/LocalMemoryRecallTool/LocalMemoryRecallTool.js"
import { VaultHttpFetchTool } from "src/tools/VaultHttpFetchTool/VaultHttpFetchTool.js"
import uniqBy from "lodash-es/uniqBy.js"
import { isSearchExtraToolsEnabledOptimistic } from "../utils/searchExtraTools.js"
import { SYNTHETIC_OUTPUT_TOOL_NAME } from "src/tools/SyntheticOutputTool/SyntheticOutputTool.js"
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from "../constants/tools.js"
import type { ToolPermissionContext } from "../Tool.js"
import { getDenyRuleForTool } from "../utils/permissions/permissions.js"
import { hasEmbeddedSearchTools } from "../utils/embeddedTools.js"

/** Built-in tools exposed by Wren's normal runtime. */
export const WREN_DEFAULT_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "TodoWrite",
  "AskUserQuestion",
  "Bash",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Skill",
  "LocalMemoryRecall",
  "EnterPlanMode",
  "ExitPlanMode",
  "GoalTool",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "LSP",
  "VerifyPlanExecution",
  "SearchExtraTools",
  "ExecuteExtraTool",
]

export const TOOL_PRESETS = ["default"] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map((tool) => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map((tool) => tool.name)
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
/**
 * NOTE: The system prompt caching strategy must stay consistent across
 * versions to ensure prompts are cached across users.
 */
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
    // trick as ripgrep). When available, find/grep in Wren's shell are aliased
    // to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    LocalMemoryRecallTool,
    VaultHttpFetchTool,
    ConfigTool,
    ...(GoalTool ? [GoalTool] : []),
    LSPTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    SendMessageTool,
    TeamCreateTool,
    TeamDeleteTool,
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...[CronCreateTool, CronDeleteTool, CronListTool],
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // Include SearchExtraToolsTool when tool search might be enabled (optimistic check)
    // The actual decision to defer tools happens at request time in claude.ts
    ...(isSearchExtraToolsEnabledOptimistic() ? [SearchExtraToolsTool] : []),
    // ExecuteExtraTool (ExecuteTool) is a first-class tool — always available, not deferred.
    // Models use it to invoke deferred tools discovered via SearchExtraTools.
    ExecuteTool,
  ]
}

/**
 * Filters out tools that are blanket-denied by the permission context.
 * A tool is filtered out if there's a deny rule matching its name with no
 * ruleContent (i.e., a blanket deny for that tool).
 *
 * Uses the same matcher as the runtime permission check (step 1a), so MCP
 * server-prefix rules like `mcp__server` strip all tools from that server
 * before the model sees them — not just at call time.
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter((tool) => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Get all base tools and filter out special tools that get added conditionally
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter((tool) => !specialTools.has(tool.name))

  // Filter out tools that are denied by the deny rules
  const allowedTools = filterToolsByDenyRules(tools, permissionContext)

  const isEnabled = allowedTools.map((_) => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * Assemble the full tool pool for a given permission context and MCP tools.
 *
 * This is the single source of truth for combining built-in tools with MCP tools.
 * Both REPL.tsx (via useMergedTools hook) and runAgent.ts (for coordinator workers)
 * use this function to ensure consistent tool pool assembly.
 *
 * The function:
 * 1. Gets built-in tools via getTools() (respects mode filtering)
 * 2. Filters MCP tools by deny rules
 * 3. Deduplicates by tool name (built-in tools take precedence)
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined, deduplicated array of built-in and MCP tools
 */
export function assembleToolPool(permissionContext: ToolPermissionContext, mcpTools: Tools): Tools {
  const builtInTools = getTools(permissionContext)

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins. uniqBy
  // preserves insertion order, so built-ins win on name conflict.
  // Avoid Array.toSorted (Node 20+) — we support Node 18. builtInTools is
  // readonly so copy-then-sort; allowedMcpTools is a fresh .filter() result.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy([...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)), "name")
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isSearchExtraToolsEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
export function getMergedTools(permissionContext: ToolPermissionContext, mcpTools: Tools): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}

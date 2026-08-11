import { APIUserAbortError } from "@anthropic-ai/sdk"
import { AGENT_TOOL_NAME } from "src/tools/AgentTool/constants.js"
import { shouldUseSandbox } from "src/tools/BashTool/shouldUseSandbox.js"
import { BASH_TOOL_NAME } from "src/tools/BashTool/toolName.js"
import { POWERSHELL_TOOL_NAME } from "src/tools/PowerShellTool/toolName.js"
import { REPL_TOOL_NAME } from "src/tools/REPLTool/constants.js"
import type { CanUseToolFn } from "../../hooks/useCanUseTool.js"
import {
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from "../../services/mcp/mcpStringUtils.js"
import type { Tool, ToolPermissionContext, ToolUseContext } from "../../Tool.js"
import type { AssistantMessage } from "../../types/message.js"
import { extractOutputRedirections } from "../bash/commands.js"
import { logForDebugging } from "../debug.js"
import { AbortError, toError } from "../errors.js"
import { logError } from "../log.js"
import { SandboxManager } from "../sandbox/sandbox-adapter.js"
import { getSettingSourceDisplayNameLowercase, SETTING_SOURCES } from "../settings/constants.js"
import { plural } from "../stringUtils.js"
import { permissionModeTitle } from "./PermissionMode.js"
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from "./PermissionResult.js"
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from "./PermissionRule.js"
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  persistPermissionUpdates,
} from "./PermissionUpdate.js"
import type { PermissionUpdate, PermissionUpdateDestination } from "./PermissionUpdateSchema.js"
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from "./permissionRuleParser.js"
import {
  deletePermissionRuleFromSettings,
  type PermissionRuleFromEditableSettings,
  shouldAllowManagedPermissionRulesOnly,
} from "./permissionsLoader.js"

const autoModeStateModule = null

import {
  addToTurnClassifierDuration,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from "../../bootstrap/state.js"


import { clearClassifierChecking, setClassifierChecking } from "../classifierApprovals.js"
import { executePermissionRequestHooks } from "../hooks.js"
import {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  DONT_ASK_REJECT_MESSAGE,
} from "../messages.js"
import { calculateCostFromTokens } from "../modelCost.js"
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonStringify } from "../slowOperations.js"
import { isAutoModeAllowlistedTool } from "./classifierDecision.js"
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  type DenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from "./denialTracking.js"
import { classifyYoloAction, formatActionForClassifier } from "./yoloClassifier.js"

const CLASSIFIER_FAIL_CLOSED_REFRESH_MS = 30 * 60 * 1000 // 30 minutes

const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,
  "cliArg",
  "command",
  "session",
] as const satisfies readonly PermissionRuleSource[]

export function permissionRuleSourceDisplayString(source: PermissionRuleSource): string {
  return getSettingSourceDisplayNameLowercase(source)
}

export function getAllowRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (context.alwaysAllowRules[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: "allow",
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

/**
 * Creates a permission request message that explain the permission request
 */
export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  // Handle different decision reason types
  if (decisionReason) {
    if ((false || false) && (decisionReason as { type: string }).type === "classifier") {
      const dr = decisionReason as { type: "classifier"; classifier: string; reason: string }
      return `Classifier '${dr.classifier}' requires approval for this ${toolName} command: ${dr.reason}`
    }
    switch (decisionReason.type) {
      case "hook": {
        const hookMessage = decisionReason.reason
          ? `Hook '${decisionReason.hookName}' blocked this action: ${decisionReason.reason}`
          : `Hook '${decisionReason.hookName}' requires approval for this ${toolName} command`
        return hookMessage
      }
      case "rule": {
        const ruleString = permissionRuleValueToString(decisionReason.rule.ruleValue)
        const sourceString = permissionRuleSourceDisplayString(decisionReason.rule.source)
        return `Permission rule '${ruleString}' from ${sourceString} requires approval for this ${toolName} command`
      }
      case "subcommandResults": {
        const needsApproval: string[] = []
        for (const [cmd, result] of decisionReason.reasons) {
          if (result.behavior === "ask" || result.behavior === "passthrough") {
            // Strip output redirections for display to avoid showing filenames as commands
            // Only do this for Bash tool to avoid affecting other tools
            if (toolName === "Bash") {
              const { commandWithoutRedirections, redirections } = extractOutputRedirections(cmd)
              // Only use stripped version if there were actual redirections
              const displayCmd = redirections.length > 0 ? commandWithoutRedirections : cmd
              needsApproval.push(displayCmd)
            } else {
              needsApproval.push(cmd)
            }
          }
        }
        if (needsApproval.length > 0) {
          const n = needsApproval.length
          return `This ${toolName} command contains multiple operations. The following ${plural(n, "part")} ${plural(n, "requires", "require")} approval: ${needsApproval.join(", ")}`
        }
        return `This ${toolName} command contains multiple operations that require approval`
      }
      case "permissionPromptTool":
        return `Tool '${decisionReason.permissionPromptToolName}' requires approval for this ${toolName} command`
      case "sandboxOverride":
        return "Run outside of the sandbox"
      case "workingDir":
        return decisionReason.reason
      case "safetyCheck":
      case "other":
        return decisionReason.reason
      case "mode": {
        const modeTitle = permissionModeTitle(decisionReason.mode)
        return `Current permission mode (${modeTitle}) requires approval for this ${toolName} command`
      }
      case "asyncAgent":
        return decisionReason.reason
    }
  }

  // Default message without listing allowed commands
  const message = `Wren requested permissions to use ${toolName}, but you haven't granted it yet.`

  return message
}

export function getDenyRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (context.alwaysDenyRules[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: "deny",
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

export function getAskRules(context: ToolPermissionContext): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (context.alwaysAskRules[source] || []).map((ruleString) => ({
      source,
      ruleBehavior: "ask",
      ruleValue: permissionRuleValueFromString(ruleString),
    })),
  )
}

/**
 * Check if the entire tool matches a rule
 * For example, this matches "Bash" but not "Bash(prefix:*)" for BashTool
 * This also matches MCP tools with a server name, e.g. the rule "mcp__server1"
 */
function toolMatchesRule(tool: Pick<Tool, "name" | "mcpInfo">, rule: PermissionRule): boolean {
  // Rule must not have content to match the entire tool
  if (rule.ruleValue.ruleContent !== undefined) {
    return false
  }

  // MCP tools are matched by their fully qualified mcp__server__tool name, so
  // rules targeting builtins should not match their MCP replacements.
  const nameForRuleMatch = getToolNameForPermissionCheck(tool)

  // Direct tool name match
  if (rule.ruleValue.toolName === nameForRuleMatch) {
    return true
  }

  // MCP server-level permission: rule "mcp__server1" matches tool "mcp__server1__tool1"
  // Also supports wildcard: rule "mcp__server1__*" matches all tools from server1
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)

  return (
    ruleInfo !== null &&
    toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === "*") &&
    ruleInfo.serverName === toolInfo.serverName
  )
}

/**
 * Check if the entire tool is listed in the always allow rules
 * For example, this finds "Bash" but not "Bash(prefix:*)" for BashTool
 */
export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, "name" | "mcpInfo">,
): PermissionRule | null {
  return getAllowRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

/**
 * Check if the tool is listed in the always deny rules
 */
export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, "name" | "mcpInfo">,
): PermissionRule | null {
  return getDenyRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

/**
 * Check if the tool is listed in the always ask rules
 */
export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, "name" | "mcpInfo">,
): PermissionRule | null {
  return getAskRules(context).find((rule) => toolMatchesRule(tool, rule)) || null
}

/**
 * Check if a specific agent is denied via Agent(agentType) syntax.
 * For example, Agent(Explore) would deny the Explore agent.
 */
export function getDenyRuleForAgent(
  context: ToolPermissionContext,
  agentToolName: string,
  agentType: string,
): PermissionRule | null {
  return (
    getDenyRules(context).find(
      (rule) =>
        rule.ruleValue.toolName === agentToolName && rule.ruleValue.ruleContent === agentType,
    ) || null
  )
}

/**
 * Filter agents to exclude those that are denied via Agent(agentType) syntax.
 */
export function filterDeniedAgents<T extends { agentType: string }>(
  agents: T[],
  context: ToolPermissionContext,
  agentToolName: string,
): T[] {
  // Parse deny rules once and collect Agent(x) contents into a Set.
  // Previously this called getDenyRuleForAgent per agent, which re-parsed
  // every deny rule for every agent (O(agents×rules) parse calls).
  const deniedAgentTypes = new Set<string>()
  for (const rule of getDenyRules(context)) {
    if (rule.ruleValue.toolName === agentToolName && rule.ruleValue.ruleContent !== undefined) {
      deniedAgentTypes.add(rule.ruleValue.ruleContent)
    }
  }
  return agents.filter((agent) => !deniedAgentTypes.has(agent.agentType))
}

/**
 * Map of rule contents to the associated rule for a given tool.
 * e.g. the string key is "prefix:*" from "Bash(prefix:*)" for BashTool
 */
export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return getRuleByContentsForToolName(context, getToolNameForPermissionCheck(tool), behavior)
}

// Used to break circular dependency where a Tool calls this function
export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const ruleByContents = new Map<string, PermissionRule>()
  let rules: PermissionRule[] = []
  switch (behavior) {
    case "allow":
      rules = getAllowRules(context)
      break
    case "deny":
      rules = getDenyRules(context)
      break
    case "ask":
      rules = getAskRules(context)
      break
  }
  for (const rule of rules) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined &&
      rule.ruleBehavior === behavior
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return ruleByContents
}

/**
 * Runs PermissionRequest hooks for headless/async agents that cannot show
 * permission prompts. This gives hooks an opportunity to allow or deny
 * tool use before the fallback auto-deny kicks in.
 *
 * Returns a PermissionDecision if a hook made a decision, or null if no
 * hook provided a decision (caller should proceed to auto-deny).
 */
async function runPermissionRequestHooksForHeadlessAgent(
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseID: string,
  context: ToolUseContext,
  permissionMode: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | null> {
  try {
    for await (const hookResult of executePermissionRequestHooks(
      tool.name,
      toolUseID,
      input,
      context,
      permissionMode,
      suggestions as any,
      context.abortController.signal,
    )) {
      if (!hookResult.permissionRequestResult) {
        continue
      }
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === "allow") {
        const finalInput = decision.updatedInput ?? input
        // Persist permission updates if provided
        if (decision.updatedPermissions?.length) {
          persistPermissionUpdates(decision.updatedPermissions as any)
          context.setAppState((prev) => ({
            ...prev,
            toolPermissionContext: applyPermissionUpdates(
              prev.toolPermissionContext,
              decision.updatedPermissions as any,
            ),
          }))
        }
        return {
          behavior: "allow",
          updatedInput: finalInput,
          decisionReason: {
            type: "hook",
            hookName: "PermissionRequest",
          },
        }
      }
      if (decision.behavior === "deny") {
        if (decision.interrupt) {
          logForDebugging(`Hook interrupt: tool=${tool.name} hookMessage=${decision.message}`)
          context.abortController.abort()
        }
        return {
          behavior: "deny",
          message: decision.message || "Permission denied by hook",
          decisionReason: {
            type: "hook",
            hookName: "PermissionRequest",
            reason: decision.message,
          },
        }
      }
    }
  } catch (error) {
    // If hooks fail, fall through to auto-deny rather than crashing
    logError(
      new Error("PermissionRequest hook failed for headless agent", {
        cause: toError(error),
      }),
    )
  }
  return null
}

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  assistantMessage,
  toolUseID,
): Promise<PermissionDecision> => {
  const result = await hasPermissionsToUseToolInner(tool, input, context)

  // Reset consecutive denials on any allowed tool use in auto mode.
  // This ensures that a successful tool use (even one auto-allowed by rules)
  // breaks the consecutive denial streak.
  if (result.behavior === "allow") {
    return result
  }

  // Apply dontAsk mode transformation: convert 'ask' to 'deny'
  // This is done at the end so it can't be bypassed by early returns
  if (result.behavior === "ask") {
    const appState = context.getAppState()

    if (appState.toolPermissionContext.mode === "dontAsk") {
      return {
        behavior: "deny",
        decisionReason: {
          type: "mode",
          mode: "dontAsk",
        },
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
      }
    }


    // When permission prompts should be avoided (e.g., background/headless agents),
    // run PermissionRequest hooks first to give them a chance to allow/deny.
    // Only auto-deny if no hook provides a decision.
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await runPermissionRequestHooksForHeadlessAgent(
        tool,
        input,
        toolUseID,
        context,
        appState.toolPermissionContext.mode,
        result.suggestions,
      )
      if (hookDecision) {
        return hookDecision
      }
      return {
        behavior: "deny",
        decisionReason: {
          type: "asyncAgent",
          reason: "Permission prompts are not available in this context",
        },
        message: AUTO_REJECT_MESSAGE(tool.name),
      }
    }
  }

  return result
}

/**
 * Persist denial tracking state. For async subagents with localDenialTracking,
 * mutate the local state in place (since setAppState is a no-op). Otherwise,
 * write to appState as usual.
 */
function persistDenialState(context: ToolUseContext, newState: DenialTrackingState): void {
  if (context.localDenialTracking) {
    Object.assign(context.localDenialTracking, newState)
  } else {
    context.setAppState((prev) => {
      // recordSuccess returns the same reference when state is
      // unchanged. Returning prev here lets store.setState's Object.is check
      // skip the listener loop entirely.
      if (prev.denialTracking === newState) return prev
      return { ...prev, denialTracking: newState }
    })
  }
}

/**
 * Check if a denial limit was exceeded and return an 'ask' result
 * so the user can review. Returns null if no limit was hit.
 */
function handleDenialLimitExceeded(
  denialState: DenialTrackingState,
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  },
  classifierReason: string,
  assistantMessage: AssistantMessage,
  tool: Tool,
  result: PermissionDecision,
  context: ToolUseContext,
): PermissionDecision | null {
  if (!shouldFallbackToPrompting(denialState)) {
    return null
  }

  const hitTotalLimit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  const isHeadless = appState.toolPermissionContext.shouldAvoidPermissionPrompts
  // Capture counts before persistDenialState, which may mutate denialState
  // in-place via Object.assign for subagents with localDenialTracking.
  const totalCount = denialState.totalDenials
  const consecutiveCount = denialState.consecutiveDenials
  const warning = hitTotalLimit
    ? `${totalCount} actions were blocked this session. Please review the transcript before continuing.`
    : `${consecutiveCount} consecutive actions were blocked. Please review the transcript before continuing.`



  if (isHeadless) {
    throw new AbortError("Agent aborted: too many classifier denials in headless mode")
  }

  logForDebugging(`Classifier denial limit exceeded, falling back to prompting: ${warning}`, {
    level: "warn",
  })

  if (hitTotalLimit) {
    persistDenialState(context, {
      ...denialState,
      totalDenials: 0,
      consecutiveDenials: 0,
    })
  }

  // Preserve the original classifier value (e.g. 'dangerous-agent-action')
  // so downstream analytics in interactiveHandler can log the correct
  // user override event.
  const originalClassifier =
    result.decisionReason?.type === "classifier" ? result.decisionReason.classifier : "auto-mode"

  return {
    ...result,
    decisionReason: {
      type: "classifier",
      classifier: originalClassifier,
      reason: `${warning}\n\nLatest blocked action: ${classifierReason}`,
    },
  }
}

/**
 * Check only the rule-based steps of the permission pipeline — the subset
 * that full mode respects (everything that fires before step 2a).
 *
 * Returns a deny/ask decision if a rule blocks the tool, or null if no rule
 * objects. Unlike hasPermissionsToUseTool, this does NOT run the auto mode classifier,
 * mode-based transformations (dontAsk/auto/asyncAgent), PermissionRequest hooks,
 * or full / always-allowed checks.
 *
 * Caller must pre-check tool.requiresUserInteraction() — step 1e is not replicated.
 */
export async function checkRuleBasedPermissions(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionAskDecision | PermissionDenyDecision | null> {
  const appState = context.getAppState()

  // 1a. Entire tool is denied by rule
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: "deny",
      decisionReason: {
        type: "rule",
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. Entire tool has an ask rule
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: "ask",
        decisionReason: {
          type: "rule",
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // Fall through to let tool.checkPermissions handle command-specific rules
  }

  // 1c. Tool-specific permission check (e.g. bash subcommand rules)
  let toolPermissionResult: PermissionResult = {
    behavior: "passthrough",
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    if (e instanceof AbortError || e instanceof APIUserAbortError) {
      throw e
    }
    logError(e)
  }

  // 1d. Tool implementation denied (catches bash subcommand denies wrapped
  // in subcommandResults — no need to inspect decisionReason.type)
  if (toolPermissionResult?.behavior === "deny") {
    return toolPermissionResult
  }

  // 1f. Content-specific ask rules from tool.checkPermissions
  // (e.g. Bash(npm publish:*) → {ask, type:'rule', ruleBehavior:'ask'})
  if (
    toolPermissionResult?.behavior === "ask" &&
    toolPermissionResult.decisionReason?.type === "rule" &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === "ask"
  ) {
    return toolPermissionResult
  }

  // 1g. Safety checks (e.g. .git/, .wren/, .vscode/, shell configs) are
  // bypass-immune — they must prompt even when a PreToolUse hook returned
  // allow. checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these.
  if (
    toolPermissionResult?.behavior === "ask" &&
    toolPermissionResult.decisionReason?.type === "safetyCheck"
  ) {
    return toolPermissionResult
  }

  // No rule-based objection
  return null
}

async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision> {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  let appState = context.getAppState()

  // 1. Check if the tool is denied
  // 1a. Entire tool is denied
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: "deny",
      decisionReason: {
        type: "rule",
        rule: denyRule,
      },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 1b. Check if the entire tool should always ask for permission
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    // When autoAllowBashIfSandboxed is on, sandboxed commands skip the ask rule and
    // auto-allow via Bash's checkPermissions. Commands that won't be sandboxed (excluded
    // commands, dangerouslyDisableSandbox) still need to respect the ask rule.
    const canSandboxAutoAllow =
      tool.name === BASH_TOOL_NAME &&
      SandboxManager.isSandboxingEnabled() &&
      SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
      shouldUseSandbox(input)

    if (!canSandboxAutoAllow) {
      return {
        behavior: "ask",
        decisionReason: {
          type: "rule",
          rule: askRule,
        },
        message: createPermissionRequestMessage(tool.name),
      }
    }
    // Fall through to let Bash's checkPermissions handle command-specific rules
  }

  // 1c. Ask the tool implementation for a permission result
  // Overridden unless tool input schema is not valid
  let toolPermissionResult: PermissionResult = {
    behavior: "passthrough",
    message: createPermissionRequestMessage(tool.name),
  }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) {
    // Rethrow abort errors so they propagate properly
    if (e instanceof AbortError || e instanceof APIUserAbortError) {
      throw e
    }
    logError(e)
  }

  // 1d. Tool implementation denied permission
  if (toolPermissionResult?.behavior === "deny") {
    return toolPermissionResult
  }

  // 1e. Tool requires user interaction even in bypass mode
  if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === "ask") {
    return toolPermissionResult
  }

  // 1f. Content-specific ask rules from tool.checkPermissions take precedence
  // over full mode. When a user explicitly configures a
  // content-specific ask rule (e.g. Bash(npm publish:*)), the tool's
  // checkPermissions returns {behavior:'ask', decisionReason:{type:'rule',
  // rule:{ruleBehavior:'ask'}}}. This must be respected even in bypass mode,
  // just as deny rules are respected at step 1d.
  if (
    toolPermissionResult?.behavior === "ask" &&
    toolPermissionResult.decisionReason?.type === "rule" &&
    toolPermissionResult.decisionReason.rule.ruleBehavior === "ask"
  ) {
    return toolPermissionResult
  }

  // 1g. Safety checks (e.g. .git/, .wren/, .vscode/, shell configs) are
  // bypass-immune — they must prompt even in full mode.
  // checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these paths.
  if (
    toolPermissionResult?.behavior === "ask" &&
    toolPermissionResult.decisionReason?.type === "safetyCheck"
  ) {
    return toolPermissionResult
  }

  // 2a. Check if mode allows the tool to run
  // IMPORTANT: Call getAppState() to get the latest value
  appState = context.getAppState()
  // Check if permissions should be bypassed:
  // - Direct full mode
  // - Plan mode when the user originally started with bypass mode (isFullModeAvailable)
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === "full" ||
    (appState.toolPermissionContext.mode === "plan" &&
      appState.toolPermissionContext.isFullModeAvailable)
  if (shouldBypassPermissions) {
    return {
      behavior: "allow",
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: "mode",
        mode: appState.toolPermissionContext.mode,
      },
    }
  }

  // 2b. Entire tool is allowed
  const alwaysAllowedRule = toolAlwaysAllowedRule(appState.toolPermissionContext, tool)
  if (alwaysAllowedRule) {
    return {
      behavior: "allow",
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: "rule",
        rule: alwaysAllowedRule,
      },
    }
  }

  // 3. Convert "passthrough" to "ask"
  const result: PermissionDecision =
    toolPermissionResult.behavior === "passthrough"
      ? {
          ...toolPermissionResult,
          behavior: "ask" as const,
          message: createPermissionRequestMessage(tool.name, toolPermissionResult.decisionReason),
        }
      : toolPermissionResult

  if (result.behavior === "ask" && result.suggestions) {
    logForDebugging(
      `Permission suggestions for ${tool.name}: ${jsonStringify(result.suggestions, null, 2)}`,
    )
  }

  return result
}

type EditPermissionRuleArgs = {
  initialContext: ToolPermissionContext
  setToolPermissionContext: (updatedContext: ToolPermissionContext) => void
}

/**
 * Delete a permission rule from the appropriate destination
 */
export async function deletePermissionRule({
  rule,
  initialContext,
  setToolPermissionContext,
}: EditPermissionRuleArgs & { rule: PermissionRule }): Promise<void> {
  if (
    rule.source === "policySettings" ||
    rule.source === "flagSettings" ||
    rule.source === "command"
  ) {
    throw new Error("Cannot delete permission rules from read-only settings")
  }

  const updatedContext = applyPermissionUpdate(initialContext, {
    type: "removeRules",
    rules: [rule.ruleValue],
    behavior: rule.ruleBehavior,
    destination: rule.source as PermissionUpdateDestination,
  })

  // Per-destination logic to delete the rule from settings
  const destination = rule.source
  switch (destination) {
    case "localSettings":
    case "userSettings":
    case "projectSettings": {
      // Note: Typescript doesn't know that rule conforms to `PermissionRuleFromEditableSettings` even when we switch on `rule.source`
      deletePermissionRuleFromSettings(rule as PermissionRuleFromEditableSettings)
      break
    }
    case "cliArg":
    case "session": {
      // No action needed for in-memory sources - not persisted to disk
      break
    }
  }

  // Update React state with updated context
  setToolPermissionContext(updatedContext)
}

/**
 * Helper to convert PermissionRule array to PermissionUpdate array
 */
function convertRulesToUpdates(
  rules: PermissionRule[],
  updateType: "addRules" | "replaceRules",
): PermissionUpdate[] {
  // Group rules by source and behavior
  const grouped = new Map<string, PermissionRuleValue[]>()

  for (const rule of rules) {
    const key = `${rule.source}:${rule.ruleBehavior}`
    if (!grouped.has(key)) {
      grouped.set(key, [])
    }
    grouped.get(key)!.push(rule.ruleValue)
  }

  // Convert to PermissionUpdate array
  const updates: PermissionUpdate[] = []
  for (const [key, ruleValues] of grouped) {
    const [source, behavior] = key.split(":")
    updates.push({
      type: updateType,
      rules: ruleValues,
      behavior: behavior as PermissionBehavior,
      destination: source as PermissionUpdateDestination,
    })
  }

  return updates
}

/**
 * Apply permission rules to context (additive - for initial setup)
 */
export function applyPermissionRulesToPermissionContext(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  const updates = convertRulesToUpdates(rules, "addRules")
  return applyPermissionUpdates(toolPermissionContext, updates)
}

/**
 * Sync permission rules from disk (replacement - for settings changes)
 */
export function syncPermissionRulesFromDisk(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let context = toolPermissionContext

  // When allowManagedPermissionRulesOnly is enabled, clear all non-policy sources
  if (shouldAllowManagedPermissionRulesOnly()) {
    const sourcesToClear: PermissionUpdateDestination[] = [
      "userSettings",
      "projectSettings",
      "localSettings",
      "cliArg",
      "session",
    ]
    const behaviors: PermissionBehavior[] = ["allow", "deny", "ask"]

    for (const source of sourcesToClear) {
      for (const behavior of behaviors) {
        context = applyPermissionUpdate(context, {
          type: "replaceRules",
          rules: [],
          behavior,
          destination: source,
        })
      }
    }
  }

  // Clear all disk-based source:behavior combos before applying new rules.
  // Without this, removing a rule from settings (e.g. deleting a deny entry)
  // would leave the old rule in the context because convertRulesToUpdates
  // only generates replaceRules for source:behavior pairs that have rules —
  // an empty group produces no update, so stale rules persist.
  const diskSources: PermissionUpdateDestination[] = [
    "userSettings",
    "projectSettings",
    "localSettings",
  ]
  for (const diskSource of diskSources) {
    for (const behavior of ["allow", "deny", "ask"] as PermissionBehavior[]) {
      context = applyPermissionUpdate(context, {
        type: "replaceRules",
        rules: [],
        behavior,
        destination: diskSource,
      })
    }
  }

  const updates = convertRulesToUpdates(rules, "replaceRules")
  return applyPermissionUpdates(context, updates)
}

/**
 * Extract updatedInput from a permission result, falling back to the original input.
 * Handles the case where some PermissionResult variants don't have updatedInput.
 */
function getUpdatedInputOrFallback(
  permissionResult: PermissionResult,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return (
    ("updatedInput" in permissionResult ? permissionResult.updatedInput : undefined) ?? fallback
  )
}

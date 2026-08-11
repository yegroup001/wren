import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs"
import uniqBy from "lodash-es/uniqBy.js"
import { dirname } from "path"
import {
  addInvokedSkill,
  clearInvokedSkillsForAgent,
  getProjectRoot,
  getSessionId,
} from "src/bootstrap/state.js"
import { builtInCommandNames, findCommand, getCommands, type PromptCommand } from "src/commands.js"
import { COMMAND_MESSAGE_TAG } from "src/constants/xml.js"
import type { CanUseToolFn } from "src/hooks/useCanUseTool.js"
import type {
  Tool,
  ToolCallProgress,
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from "src/Tool.js"
import { buildTool, type ToolDef } from "src/Tool.js"
import type { Command } from "src/types/command.js"
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from "src/types/message.js"
import { getAgentContext } from "src/utils/agentContext.js"
import { logForDebugging } from "src/utils/debug.js"
import { errorMessage } from "src/utils/errors.js"
import { extractResultText, prepareForkedCommandContext } from "src/utils/forkedAgent.js"
import { parseFrontmatter } from "src/utils/frontmatterParser.js"
import { lazySchema } from "src/utils/lazySchema.js"
import { createUserMessage, normalizeMessages } from "src/utils/messages.js"
import type { ModelAlias } from "src/utils/model/aliases.js"
import { resolveSkillModelOverride } from "src/utils/model/model.js"
import type { PermissionDecision } from "src/utils/permissions/PermissionResult.js"
import { getRuleByContentsForTool } from "src/utils/permissions/permissions.js"
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from "src/utils/plugins/pluginIdentifier.js"
import { recordSkillUsage } from "src/utils/suggestions/skillUsageTracking.js"
import { createAgentId } from "src/utils/uuid.js"
import { z } from "zod/v4"
import { runAgent } from "../AgentTool/runAgent.js"
import { getToolUseIDFromParentMessage, tagMessagesWithToolUseID } from "../utils.js"
import { SKILL_TOOL_NAME } from "./constants.js"
import { getPrompt } from "./prompt.js"

/**
 * Gets all commands including MCP skills/prompts from AppState.
 * SkillTool needs this because getCommands() only returns local/bundled skills.
 */
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // Only include MCP skills (loadedFrom === 'mcp'), not plain MCP prompts.
  // Before this filter, the model could invoke MCP prompts via SkillTool
  // if it guessed the mcp__server__prompt name — they weren't discoverable
  // but were technically reachable.
  const mcpSkills = context
    .getAppState()
    .mcp.commands.filter((cmd) => cmd.type === "prompt" && cmd.loadedFrom === "mcp")
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  return uniqBy([...localCommands, ...mcpSkills], "name")
}

// Re-export Progress from centralized types to break import cycles
export type { SkillToolProgress as Progress } from "src/types/tools.js"

import type { SkillToolProgress as Progress } from "src/types/tools.js"

/**
 * Executes a skill in a forked sub-agent context.
 * This runs the skill prompt in an isolated agent with its own token budget.
 */
async function executeForkedSkill(
  command: Command & { type: "prompt" },
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<Progress>,
): Promise<ToolResult<Output>> {
  const startTime = Date.now()
  const agentId = createAgentId()

  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || "", context)

  // Merge skill's effort into the agent definition so runAgent applies it
  const agentDefinition =
    command.effort !== undefined ? { ...baseAgent, effort: command.effort } : baseAgent

  // Collect messages from the forked agent
  const agentMessages: Message[] = []

  logForDebugging(
    `SkillTool executing forked skill ${commandName} with agent ${agentDefinition.agentType}`,
  )

  try {
    // Run the sub-agent
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: "agent:custom",
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      agentMessages.push(message)

      // Report progress for tool uses (like AgentTool does)
      if ((message.type === "assistant" || message.type === "user") && onProgress) {
        const normalizedNew = normalizeMessages([message])
        for (const m of normalizedNew) {
          const contentArray = m.message?.content
          const hasToolContent =
            Array.isArray(contentArray) &&
            contentArray.some(
              (c: { type: string }) => c.type === "tool_use" || c.type === "tool_result",
            )
          if (hasToolContent) {
            onProgress({
              toolUseID: `skill_${parentMessage.message.id}`,
              data: {
                message: m,
                type: "skill_progress",
                prompt: skillContent,
                agentId,
              },
            })
          }
        }
      }
    }

    const resultText = extractResultText(agentMessages, "Skill execution completed")
    // Release message memory after extracting result
    agentMessages.length = 0

    const durationMs = Date.now() - startTime
    logForDebugging(`SkillTool forked skill ${commandName} completed in ${durationMs}ms`)

    return {
      data: {
        success: true,
        commandName,
        status: "forked",
        agentId,
        result: resultText,
      },
    }
  } finally {
    // Release skill content from invokedSkills state
    clearInvokedSkillsForAgent(agentId)
  }
}

export const inputSchema = lazySchema(() =>
  z.object({
    skill: z.string().describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
    args: z.string().optional().describe("Optional arguments for the skill"),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() => {
  // Output schema for inline skills (default)
  const inlineOutputSchema = z.object({
    success: z.boolean().describe("Whether the skill is valid"),
    commandName: z.string().describe("The name of the skill"),
    allowedTools: z.array(z.string()).optional().describe("Tools allowed by this skill"),
    model: z.string().optional().describe("Model override if specified"),
    status: z.literal("inline").optional().describe("Execution status"),
  })

  // Output schema for forked skills
  const forkedOutputSchema = z.object({
    success: z.boolean().describe("Whether the skill completed successfully"),
    commandName: z.string().describe("The name of the skill"),
    status: z.literal("forked").describe("Execution status"),
    agentId: z.string().describe("The ID of the sub-agent that executed the skill"),
    result: z.string().describe("The result from the forked skill execution"),
  })

  return z.union([inlineOutputSchema, forkedOutputSchema])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.input<OutputSchema>

export const SkillTool: Tool<InputSchema, Output, Progress> = buildTool({
  name: SKILL_TOOL_NAME,
  searchHint: "invoke a slash-command skill",
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  description: async ({ skill }) => `Execute skill: ${skill}`,

  prompt: async () => getPrompt(getProjectRoot()),

  // Only one skill/command should run at a time, since the tool expands the
  // command into a full prompt that Wren must process before continuing.
  // Skill-coach needs the skill name to avoid false-positive "you could have
  // used skill X" suggestions when X was actually invoked. Backseat classifies
  // downstream tool calls from the expanded prompt, not this wrapper, so the
  // name alone is sufficient — it just records that the skill fired.
  toAutoClassifierInput: ({ skill }) => skill ?? "",

  async validateInput({ skill }, context): Promise<ValidationResult> {
    // Skills are just skill names, no arguments
    const trimmed = skill.trim()
    if (!trimmed) {
      return {
        result: false,
        message: `Invalid skill format: ${skill}`,
        errorCode: 1,
      }
    }

    // Remove leading slash if present (for compatibility)
    const hasLeadingSlash = trimmed.startsWith("/")
    if (hasLeadingSlash) {
    }
    const normalizedCommandName = hasLeadingSlash ? trimmed.substring(1) : trimmed

    // Remote canonical skill handling (legacy experimental). Intercept
    // `_canonical_<slug>` names before local command lookup since remote
    // skills are not in the local command registry.

    // Get available commands (including MCP skills)
    const commands = await getAllCommands(context)

    // Check if command exists
    const foundCommand = findCommand(normalizedCommandName, commands)
    if (!foundCommand) {
      return {
        result: false,
        message: `Unknown skill: ${normalizedCommandName}`,
        errorCode: 2,
      }
    }

    // Check if command has model invocation disabled
    if (foundCommand.disableModelInvocation) {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} cannot be used with ${SKILL_TOOL_NAME} tool due to disable-model-invocation`,
        errorCode: 4,
      }
    }

    // Check if command is a prompt-based command
    if (foundCommand.type !== "prompt") {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} is not a prompt-based skill`,
        errorCode: 5,
      }
    }

    return { result: true }
  },

  async checkPermissions({ skill, args }, context): Promise<PermissionDecision> {
    // Skills are just skill names, no arguments
    const trimmed = skill.trim()

    // Remove leading slash if present (for compatibility)
    const commandName = trimmed.startsWith("/") ? trimmed.substring(1) : trimmed

    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // Look up the command object to pass as metadata
    const commands = await getAllCommands(context)
    const commandObj = findCommand(commandName, commands)

    // Helper function to check if a rule matches the skill
    // Normalizes both inputs by stripping leading slashes for consistent matching
    const ruleMatches = (ruleContent: string): boolean => {
      // Normalize rule content by stripping leading slash
      const normalizedRule = ruleContent.startsWith("/") ? ruleContent.substring(1) : ruleContent

      // Check exact match (using normalized commandName)
      if (normalizedRule === commandName) {
        return true
      }
      // Check prefix match (e.g., "review:*" matches "review-pr 123")
      if (normalizedRule.endsWith(":*")) {
        const prefix = normalizedRule.slice(0, -2) // Remove ':*'
        return commandName.startsWith(prefix)
      }
      return false
    }

    // Check for deny rules
    const denyRules = getRuleByContentsForTool(permissionContext, SkillTool as Tool, "deny")
    for (const [ruleContent, rule] of denyRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: "deny",
          message: `Skill execution blocked by permission rules`,
          decisionReason: {
            type: "rule",
            rule,
          },
        }
      }
    }

    // Remote canonical skills are legacy experimental — auto-grant.
    // Placed AFTER the deny loop so a user-configured Skill(_canonical_:*)
    // deny rule is honored (same pattern as safe-properties auto-allow below).
    // The skill content itself is canonical/curated, not user-authored.

    // Check for allow rules
    const allowRules = getRuleByContentsForTool(permissionContext, SkillTool as Tool, "allow")
    for (const [ruleContent, rule] of allowRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: "allow",
          updatedInput: { skill, args },
          decisionReason: {
            type: "rule",
            rule,
          },
        }
      }
    }

    // Auto-allow skills that only use safe properties.
    // This is an allowlist: if a skill has any property NOT in this set with a
    // meaningful value, it requires permission. This ensures new properties added
    // in the future default to requiring permission.
    if (commandObj?.type === "prompt" && skillHasOnlySafeProperties(commandObj)) {
      return {
        behavior: "allow",
        updatedInput: { skill, args },
        decisionReason: undefined,
      }
    }

    // Prepare suggestions for exact skill and prefix
    // Use normalized commandName (without leading slash) for consistent rules
    const suggestions = [
      // Exact skill suggestion
      {
        type: "addRules" as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: commandName,
          },
        ],
        behavior: "allow" as const,
        destination: "localSettings" as const,
      },
      // Prefix suggestion to allow any args
      {
        type: "addRules" as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: `${commandName}:*`,
          },
        ],
        behavior: "allow" as const,
        destination: "localSettings" as const,
      },
    ]

    // Default behavior: ask user for permission
    return {
      behavior: "ask",
      message: `Execute skill: ${commandName}`,
      decisionReason: undefined,
      suggestions,
      updatedInput: { skill, args },
      metadata: commandObj ? { command: commandObj } : undefined,
    }
  },

  async call(
    { skill, args },
    context,
    canUseTool,
    parentMessage,
    onProgress?,
  ): Promise<ToolResult<Output>> {
    // At this point, validateInput has already confirmed:
    // - Skill format is valid
    // - Skill exists
    // - Skill can be loaded
    // - Skill doesn't have disableModelInvocation
    // - Skill is a prompt-based skill

    // Skills are just names, with optional arguments
    const trimmed = skill.trim()

    // Remove leading slash if present (for compatibility)
    const commandName = trimmed.startsWith("/") ? trimmed.substring(1) : trimmed

    // Remote canonical skill execution (legacy experimental). Intercepts
    // `_canonical_<slug>` before local command lookup — loads SKILL.md from
    // AKI/GCS (with local cache), injects content directly as a user message.
    // Remote skills are declarative markdown so no slash-command expansion
    // (no !command substitution, no $ARGUMENTS interpolation) is needed.

    const commands = await getAllCommands(context)
    const command = findCommand(commandName, commands)

    // Track skill usage for ranking
    recordSkillUsage(commandName)

    // Check if skill should run as a forked sub-agent
    if (command?.type === "prompt" && command.context === "fork") {
      return executeForkedSkill(
        command,
        commandName,
        args,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
    }

    // Process the skill with optional args
    const { processPromptSlashCommand } = await import(
      "src/utils/processUserInput/processSlashCommand.js"
    )
    const processedCommand = await processPromptSlashCommand(
      commandName,
      args || "", // Pass args if provided
      commands,
      context,
    )

    if (!processedCommand.shouldQuery) {
      throw new Error("Command processing failed")
    }

    // Extract metadata from the command
    const allowedTools = processedCommand.allowedTools || []
    const model = processedCommand.model
    const effort = command?.type === "prompt" ? command.effort : undefined

    // Get the tool use ID from the parent message for linking newMessages
    const toolUseID = getToolUseIDFromParentMessage(parentMessage, SKILL_TOOL_NAME)

    // Tag user messages with sourceToolUseID so they stay transient until this tool resolves
    const newMessages = tagMessagesWithToolUseID(
      processedCommand.messages.filter(
        (m): m is UserMessage | AttachmentMessage | SystemMessage => {
          if (m.type === "progress") {
            return false
          }
          // Filter out command-message since SkillTool handles display
          if (m.type === "user" && "message" in m) {
            const content = m.message.content
            if (typeof content === "string" && content.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
              return false
            }
          }
          return true
        },
      ),
      toolUseID,
    )

    logForDebugging(
      `SkillTool returning ${newMessages.length} newMessages for skill ${commandName}`,
    )

    // Note: addInvokedSkill and registerSkillHooks are called inside
    // processPromptSlashCommand (via getMessagesForPromptSlashCommand), so
    // calling them again here would double-register hooks and rebuild
    // skillContent redundantly.

    // Return success with newMessages and contextModifier
    return {
      data: {
        success: true,
        commandName,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        model,
      },
      newMessages,
      contextModifier(ctx) {
        let modifiedContext = ctx

        // Update allowed tools if specified
        if (allowedTools.length > 0) {
          // Capture the current getAppState to chain modifications properly
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              // Use the previous getAppState, not the closure's context.getAppState,
              // to properly chain context modifications
              const appState = previousGetAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: [
                      ...new Set([
                        ...(appState.toolPermissionContext.alwaysAllowRules.command || []),
                        ...allowedTools,
                      ]),
                    ],
                  },
                },
              }
            },
          }
        }

        // Carry [1m] suffix over — otherwise a skill with `model: opus` on an
        // opus[1m] session drops the effective window to 200K and trips autocompact.
        if (model) {
          modifiedContext = {
            ...modifiedContext,
            options: {
              ...modifiedContext.options,
              mainLoopModel: resolveSkillModelOverride(model, ctx.options.mainLoopModel),
            },
          }
        }

        // Override effort level if skill specifies one
        if (effort !== undefined) {
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              const appState = previousGetAppState()
              return {
                ...appState,
                effortValue: effort,
              }
            },
          }
        }

        return modifiedContext
      },
    }
  },

  mapToolResultToToolResultBlockParam(result: Output, toolUseID: string): ToolResultBlockParam {
    // Handle forked skill result
    if ("status" in result && result.status === "forked") {
      return {
        type: "tool_result" as const,
        tool_use_id: toolUseID,
        content: `Skill "${result.commandName}" completed (forked execution).\n\nResult:\n${result.result}`,
      }
    }

    // Inline skill result (default)
    return {
      type: "tool_result" as const,
      tool_use_id: toolUseID,
      content: `Launching skill: ${result.commandName}`,
    }
  },
} satisfies ToolDef<InputSchema, Output, Progress>)

// Allowlist of PromptCommand property keys that are safe and don't require permission.
// If a skill has any property NOT in this set with a meaningful value, it requires
// permission. This ensures new properties added to PromptCommand in the future
// default to requiring permission until explicitly reviewed and added here.
const SAFE_SKILL_PROPERTIES = new Set([
  // PromptCommand properties
  "type",
  "progressMessage",
  "contentLength",
  "argNames",
  "model",
  "effort",
  "source",
  "pluginInfo",
  "disableNonInteractive",
  "skillRoot",
  "context",
  "agent",
  "getPromptForCommand",
  "frontmatterKeys",
  // CommandBase properties
  "name",
  "description",
  "hasUserSpecifiedDescription",
  "isEnabled",
  "isHidden",
  "aliases",
  "isMcp",
  "argumentHint",
  "whenToUse",
  "paths",
  "version",
  "disableModelInvocation",
  "userInvocable",
  "loadedFrom",
  "immediate",
  "userFacingName",
])

function skillHasOnlySafeProperties(command: Command): boolean {
  for (const key of Object.keys(command)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) {
      continue
    }
    // Property not in safe allowlist - check if it has a meaningful value
    const value = (command as Record<string, unknown>)[key]
    if (value === undefined || value === null) {
      continue
    }
    if (Array.isArray(value) && value.length === 0) {
      continue
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue
    }
    return false
  }
  return true
}

function isOfficialMarketplaceSkill(command: PromptCommand): boolean {
  if (command.source !== "plugin" || !command.pluginInfo?.repository) {
    return false
  }
  return isOfficialMarketplaceName(parsePluginIdentifier(command.pluginInfo.repository).marketplace)
}

/**
 * Extract URL scheme for telemetry. Defaults to 'gs' for unrecognized schemes
 * since the AKI backend is the only production path and the loader throws on
 * unknown schemes before we reach telemetry anyway.
 */
function extractUrlScheme(url: string): "gs" | "http" | "https" | "s3" {
  if (url.startsWith("gs://")) return "gs"
  if (url.startsWith("https://")) return "https"
  if (url.startsWith("http://")) return "http"
  if (url.startsWith("s3://")) return "s3"
  return "gs"
}

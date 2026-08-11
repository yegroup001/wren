import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs"
import type { ToolCallProgress, ToolUseContext } from "src/Tool.js"
import { buildTool, type ToolDef } from "src/Tool.js"
import { assembleToolPool } from "src/tools/index.js"
import type { Message } from "src/types/message.js"
import { isAbortError } from "src/utils/errors.js"
import { lazySchema } from "src/utils/lazySchema.js"
import { createUserMessage } from "src/utils/messages.js"
import { getAgentModel } from "src/utils/model/agent.js"
import { getQuerySourceForAgent } from "src/utils/promptCategory.js"
import { createAgentId } from "src/utils/uuid.js"
import { z } from "zod/v4"
import { finalizeAgentTool } from "./agentToolUtils.js"
import { GENERAL_PURPOSE_AGENT } from "./built-in/generalPurposeAgent.js"
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  ONE_SHOT_BUILTIN_AGENT_TYPES,
} from "./constants.js"
import type { AgentDefinition } from "./loadAgentsDir.js"
import { isBuiltInAgent } from "./loadAgentsDir.js"
import { getPrompt } from "./prompt.js"
import { runAgent } from "./runAgent.js"

// Simplified headless input schema: base fields only. Multi-agent params
// (name, team_name, mode, isolation, cwd) are omitted — they require UI and
// process management unavailable in headless mode.
const inputSchema = lazySchema(() =>
  z.object({
    description: z.string().describe("A short (3-5 word) description of the task"),
    prompt: z.string().describe("The task for the agent to perform"),
    subagent_type: z
      .string()
      .optional()
      .describe("The type of specialized agent to use for this task"),
    model: z
      .enum(["sonnet", "opus", "haiku"])
      .optional()
      .describe(
        "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Simplified sync-only output schema. The CCB version unions sync/async/
// teammate/remote results; headless supports only synchronous completion.
const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(["completed", "error", "aborted"]),
    prompt: z.string(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    agentId: z.string(),
    agentType: z.string().optional(),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    errorMessage: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

type AgentToolInput = z.infer<InputSchema>

export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,
  searchHint: "delegate work to a subagent",
  aliases: [LEGACY_AGENT_TOOL_NAME],
  maxResultSizeChars: 100_000,
  async description() {
    return "Launch a new agent"
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async prompt({ agents, allowedAgentTypes }) {
    return getPrompt(agents, false, allowedAgentTypes)
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.subagent_type ?? ""}: ${input.prompt}`
  },
  getActivityDescription(input) {
    return input?.description ?? "Running task"
  },
  // Auto-approve — the subagent's own tools go through their own permission
  // checks. The parent tool call is just a delegation boundary.
  async checkPermissions(input) {
    return { behavior: "allow" as const, updatedInput: input }
  },
  // Simplified sync-only path. The CCB version (AgentTool.tsx call(),
  // ~1100 lines) branches into teammate spawning, fork subagent, remote
  // agents, worktrees, async/background agents, progress tracking, and
  // summarization. Headless needs only: resolve agent → runAgent → finalize.
  async call(
    { prompt, subagent_type, description, model: modelParam }: AgentToolInput,
    toolUseContext: ToolUseContext,
    canUseTool: Parameters<typeof runAgent>[0]["canUseTool"],
    _parentMessage: unknown,
    onProgress?: ToolCallProgress,
  ) {
    const startTime = Date.now()

    const effectiveType = subagent_type ?? GENERAL_PURPOSE_AGENT.agentType

    // Fall back to the built-in general-purpose agent if not found among
    // registered agents — more forgiving than CCB (which throws), since
    // headless tests may not register agents.
    const registeredAgents = toolUseContext.options.agentDefinitions?.activeAgents ?? []
    const selectedAgent: AgentDefinition =
      registeredAgents.find((a) => a.agentType === effectiveType) ?? GENERAL_PURPOSE_AGENT

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    const resolvedAgentModel = getAgentModel(
      selectedAgent.model,
      toolUseContext.options.mainLoopModel,
      modelParam,
      selectedAgent.agentType,
      permissionMode,
    )

    // Workers get their own tool pool with their own permission mode,
    // independent of the parent's tool restrictions.
    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: selectedAgent.permissionMode ?? "acceptEdits",
    }
    const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)

    const agentId = createAgentId()

    // Emit agent_started progress so the TUI can attach agentId to the
    // running tool_use part, enabling click-through to the subagent
    // transcript while it's still working.
    if (onProgress) {
      onProgress({
        toolUseID: toolUseContext.toolUseId ?? "",
        data: { type: "agent_started", agentId, agentType: effectiveType },
      })
    }

    const promptMessages = [createUserMessage({ content: prompt })]
    const querySource = getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    )

    const agentMessages: Message[] = []
    let status: "completed" | "error" | "aborted" = "completed"
    let errorMessage: string | undefined

    try {
      for await (const message of runAgent({
        agentDefinition: selectedAgent,
        promptMessages,
        toolUseContext,
        canUseTool,
        isAsync: false,
        querySource,
        model: modelParam,
        availableTools: workerTools,
        description,
        override: { agentId },
      })) {
        agentMessages.push(message)
      }
    } catch (err) {
      if (isAbortError(err)) {
        status = "aborted"
      } else {
        status = "error"
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    }

    let content: Array<{ type: "text"; text: string }> = []
    try {
      const agentResult = finalizeAgentTool(agentMessages, agentId, {
        prompt,
        resolvedAgentModel,
        isBuiltInAgent: isBuiltInAgent(selectedAgent),
        startTime,
        agentType: selectedAgent.agentType,
        isAsync: false,
      })
      content = agentResult.content
    } catch {
      // finalizeAgentTool throws when there are no assistant messages.
      // Use empty content — the status already signals the failure.
    }

    return {
      data: {
        status,
        prompt,
        content,
        agentId,
        agentType: selectedAgent.agentType,
        totalToolUseCount: 0,
        totalDurationMs: Date.now() - startTime,
        totalTokens: 0,
        ...(errorMessage !== undefined && { errorMessage }),
      },
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string): ToolResultBlockParam {
    const content =
      data.content.length > 0
        ? [...data.content]
        : [
            {
              type: "text" as const,
              text:
                data.status === "aborted"
                  ? "(Subagent was aborted.)"
                  : data.status === "error"
                    ? `(Subagent error: ${data.errorMessage ?? "unknown"})`
                    : "(Subagent completed but returned no output.)",
            },
          ]

    if (data.status === "aborted") {
      content.unshift({ type: "text" as const, text: "(Agent was aborted)" })
    } else if (data.status === "error") {
      content.unshift({
        type: "text" as const,
        text: `(Agent error: ${data.errorMessage ?? "unknown"})`,
      })
    }

    if (data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType)) {
      return {
        tool_use_id: toolUseID,
        type: "tool_result",
        content: [
          ...content,
          {
            type: "text" as const,
            text: `agentId: ${data.agentId}`,
          },
        ],
      }
    }

    return {
      tool_use_id: toolUseID,
      type: "tool_result",
      content: [
        ...content,
        {
          type: "text" as const,
          text: `agentId: ${data.agentId}\n<usage>total_tokens: ${data.totalTokens}\ntool_uses: ${data.totalToolUseCount}\nduration_ms: ${data.totalDurationMs}</usage>`,
        },
      ],
    }
  },
} satisfies ToolDef<InputSchema, Output>)

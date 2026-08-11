import { BASH_TOOL_NAME } from "src/tools/BashTool/toolName.js"
import { FILE_READ_TOOL_NAME } from "src/tools/FileReadTool/prompt.js"
import { GLOB_TOOL_NAME } from "src/tools/GlobTool/prompt.js"
import { GREP_TOOL_NAME } from "src/tools/GrepTool/prompt.js"
import { SEND_MESSAGE_TOOL_NAME } from "src/tools/SendMessageTool/constants.js"
import { WEB_FETCH_TOOL_NAME } from "src/tools/WebFetchTool/prompt.js"
import { WEB_SEARCH_TOOL_NAME } from "src/tools/WebSearchTool/prompt.js"
import { isUsing3PServices } from "src/utils/auth.js"
import { hasEmbeddedSearchTools } from "src/utils/embeddedTools.js"
import { getSettings_DEPRECATED } from "src/utils/settings/settings.js"
import { jsonStringify } from "src/utils/slowOperations.js"
import type { AgentDefinition, BuiltInAgentDefinition } from "../loadAgentsDir.js"

export const WREN_GUIDE_AGENT_TYPE = "wren-guide"

function getWrenGuideBasePrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the Wren guide agent. Your primary responsibility is helping users understand and use Wren, the Claude Agent SDK, and the Claude API (formerly the Anthropic API) effectively.

**Your expertise spans three domains:**

1. **Wren** (the CLI tool): Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Claude Agent SDK**: A framework for building custom AI agents, available for Node.js/TypeScript and Python.

3. **Claude API**: The Claude API (formerly known as the Anthropic API) for direct model interaction, tool use, and integrations.

**Approach:**
1. Determine which domain the user's question falls into
2. For Wren questions: search local project files (WREN.md, .wren/ directory, settings files) using ${localSearchHint} to find relevant configuration and documentation
3. For Claude Agent SDK and Claude API questions: use ${WEB_SEARCH_TOOL_NAME} to find the latest documentation, then use ${WEB_FETCH_TOOL_NAME} to read specific pages
4. Provide clear, actionable guidance based on what you find
5. Reference local project files (WREN.md, .wren/ directory) when relevant

**Guidelines:**
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities
- When you cannot find an answer or the feature doesn't exist, let the user know

Complete the user's request by providing accurate guidance.`
}

function getFeedbackGuideline(): string {
  // For 3P services (Bedrock/Vertex/Foundry), /feedback command is disabled
  // Direct users to the appropriate feedback channel instead
  if (isUsing3PServices()) {
    return "- When you cannot find an answer or the feature doesn't exist, let the user know"
  }
  return "- When you cannot find an answer or the feature doesn't exist, direct the user to use /feedback to report a feature request or bug"
}

export const WREN_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: WREN_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can Wren...", "Does Wren...", "How do I...") about: (1) Wren (the CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Claude Agent SDK - building custom agents; (3) Claude API (formerly Anthropic API) - API usage, tool use, Anthropic SDK usage. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed wren-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // Ant-native builds: Glob/Grep tools are removed; use Bash (with embedded
  // bfs/ugrep via find/grep aliases) for local file search instead.
  tools: hasEmbeddedSearchTools()
    ? [BASH_TOOL_NAME, FILE_READ_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: "built-in",
  baseDir: "built-in",
  model: "fast",
  permissionMode: "dontAsk",
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // Build context sections
    const contextSections: string[] = []

    // 1. Custom skills
    const customCommands = commands.filter((cmd) => cmd.type === "prompt")
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map((cmd) => `- /${cmd.name}: ${cmd.description}`)
        .join("\n")
      contextSections.push(`**Available custom skills in this project:**\n${commandList}`)
    }

    // 2. Custom agents from .wren/agents/
    const customAgents = toolUseContext.options.agentDefinitions.activeAgents.filter(
      (a: AgentDefinition) => a.source !== "built-in",
    )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join("\n")
      contextSections.push(`**Available custom agents configured:**\n${agentList}`)
    }

    // 3. MCP servers
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients.map((client: { name: string }) => `- ${client.name}`).join("\n")
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. Plugin commands
    const pluginCommands = commands.filter(
      (cmd) => cmd.type === "prompt" && cmd.source === "plugin",
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map((cmd) => `- /${cmd.name}: ${cmd.description}`)
        .join("\n")
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. User settings
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(`**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``)
    }

    // Add the feedback guideline (conditional based on whether user is using 3P services)
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getWrenGuideBasePrompt()}
${feedbackGuideline}`

    // If we have any context to add, append it to the base system prompt
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join("\n\n")}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // Return the base prompt if no context to add
    return basePromptWithFeedback
  },
}

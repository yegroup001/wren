import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.mjs"
import { findCommand, getCommands, type Command } from "../../commands.js"
import {
  COMMAND_MESSAGE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from "../../constants/xml.js"
import { buildPostCompactMessages } from "../../services/compact/compact.js"
import { getCommandName, type LocalCommandResult, type LocalJSXCommandContext } from "../../types/command.js"
import type { ToolUseContext } from "../../Tool.js"
import { toError } from "../errors.js"
import { logError } from "../log.js"
import { createCommandInputMessage, createUserMessage } from "../messages.js"
import type { ProcessUserInputBaseResult, ProcessUserInputContext } from "./processUserInput.js"

/**
 * Formats the command-message breadcrumb for preloaded agent skills.
 * Mirrors formatCommandInputTags so the UI can show which skill is loading.
 */
export function formatSkillLoadingMetadata(skillName: string, progressMessage: string): string {
  const label = progressMessage ? `${skillName}: ${progressMessage}` : skillName
  return `<${COMMAND_MESSAGE_TAG}>${label}</${COMMAND_MESSAGE_TAG}>`
}

/**
 * Expands a prompt-type command (skill) into its user message without the
 * slash-command wrapper. Used by SkillTool when the model invokes a skill.
 */
export async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
): Promise<{ messages: ProcessUserInputBaseResult["messages"]; shouldQuery: boolean; allowedTools?: string[]; model?: string }> {
  const cmd = findCommand(commandName, commands)
  if (cmd === undefined || cmd.type !== "prompt") {
    return { messages: [], shouldQuery: false }
  }
  const promptContent = await cmd.getPromptForCommand(
    args,
    context as unknown as Parameters<typeof cmd.getPromptForCommand>[1],
  )
  return {
    messages: [createUserMessage({ content: promptContent as string | ContentBlockParam[] })],
    shouldQuery: true,
    allowedTools: cmd.allowedTools,
    model: cmd.model,
  }
}

/**
 * Minimal processSlashCommand — handles 'local' and 'prompt' type commands.
 * Replaces the upstream module that was stripped during vendoring.
 */
export async function processSlashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: ProcessUserInputBaseResult["messages"],
  context: ProcessUserInputContext,
  setToolJSX: (jsx: unknown) => void,
  uuid?: string,
  isAlreadyProcessing?: boolean,
  canUseTool?: (tool: unknown, input: unknown) => Promise<unknown>,
  autonomy?: unknown,
): Promise<ProcessUserInputBaseResult> {
  const trimmed = inputString.trim()
  const spaceIdx = trimmed.indexOf(" ")
  const commandName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1)

  const commands = await getCommands(process.cwd())
  const cmd = findCommand(commandName, commands)

  if (cmd === undefined) {
    return {
      messages: [createUserMessage({ content: inputString })],
      shouldQuery: true,
    }
  }

  // 'prompt' commands: expand to text and send to model
  if (cmd.type === "prompt") {
    const promptContent = await cmd.getPromptForCommand(
      args,
      context as unknown as Parameters<typeof cmd.getPromptForCommand>[1],
    )
    const userMessage = createUserMessage({
      content: promptContent as string | ContentBlockParam[],
      uuid,
    })
    return {
      messages: [userMessage, ...attachmentMessages],
      shouldQuery: true,
      allowedTools: cmd.allowedTools,
      model: cmd.model,
      resultText: undefined,
    }
  }

  // 'local' commands: load and call, then handle the result
  if (cmd.type === "local") {
    const module = await cmd.load()
    const localContext = {
      ...(context as unknown as LocalJSXCommandContext),
      setMessages: () => {},
      options: {
        ...(context as unknown as { options: Record<string, unknown> }).options,
        ideInstallationStatus: null,
        theme: "dark",
      },
      onChangeAPIKey: () => {},
      onChangeDynamicMcpConfig: () => {},
      onInstallIDEExtension: () => {},
    } as unknown as LocalJSXCommandContext
    const result: LocalCommandResult = await module.call(args, localContext)

    if (result.type === "skip") {
      return { messages: [], shouldQuery: false }
    }

    if (result.type === "compact") {
      // Compact replaces the message history. The QueryEngine's submitMessage
      // loop handles compact_boundary messages. We return the compact result
      // messages and signal shouldQuery=false so the engine yields them.
      const compactionResult = result.compactionResult
      const messages = buildPostCompactMessages(compactionResult)
      if (result.displayText) {
        messages.push(
          createCommandInputMessage(
            `<${LOCAL_COMMAND_STDOUT_TAG}>${result.displayText}</${LOCAL_COMMAND_STDOUT_TAG}>`,
          ),
        )
      }
      return {
        messages: messages as ProcessUserInputBaseResult["messages"],
        shouldQuery: false,
      }
    }

    // result.type === 'text'
    return {
      messages: [
        createCommandInputMessage(
          `<${LOCAL_COMMAND_STDOUT_TAG}>${result.value}</${LOCAL_COMMAND_STDOUT_TAG}>`,
        ),
      ],
      shouldQuery: false,
    }
  }

  // 'local-jsx' commands: not supported without React/Ink renderer
  if (cmd.type === "local-jsx") {
    return {
      messages: [
        createCommandInputMessage(
          `<${LOCAL_COMMAND_STDERR_TAG}>Command "${getCommandName(cmd)}" requires an interactive UI and is not available.</${LOCAL_COMMAND_STDERR_TAG}>`,
        ),
      ],
      shouldQuery: false,
    }
  }

  // Fallback: send as regular prompt
  return {
    messages: [createUserMessage({ content: inputString })],
    shouldQuery: true,
  }
}

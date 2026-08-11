import chalk from "chalk"
import { markPostCompaction } from "src/bootstrap/state.js"
import { getSystemPrompt } from "../../constants/prompts.js"
import { getSystemContext, getUserContext } from "../../context.js"
import type { SDKStatus } from "../../entrypoints/agentSdkTypes.js"
import { notifyCompaction } from "../../services/api/promptCacheBreakDetection.js"
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  ERROR_MESSAGE_USER_ABORT,
  mergeHookInstructions,
} from "../../services/compact/compact.js"
import { suppressCompactWarning } from "../../services/compact/compactWarningState.js"
import { microcompactMessages } from "../../services/compact/microCompact.js"
import { runPostCompactCleanup } from "../../services/compact/postCompactCleanup.js"
import { trySessionMemoryCompaction } from "../../services/compact/sessionMemoryCompact.js"
import { setLastSummarizedMessageId } from "../../services/SessionMemory/sessionMemoryUtils.js"
import type { ToolUseContext } from "../../Tool.js"
import type { LocalCommandCall } from "../../types/command.js"
import type { Message } from "../../types/message.js"
import { hasExactErrorMessage } from "../../utils/errors.js"
import { executePreCompactHooks } from "../../utils/hooks.js"
import { logError } from "../../utils/log.js"
import { getMessagesAfterCompactBoundary } from "../../utils/messages.js"
import { getUpgradeMessage } from "../../utils/model/contextWindowUpgradeCheck.js"
import { buildEffectiveSystemPrompt, type SystemPrompt } from "../../utils/systemPrompt.js"

/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-enable @typescript-eslint/no-require-imports */

export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // REPL keeps snipped messages for UI scrollback — project so the compact
  // model doesn't summarize content that was intentionally removed.
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error("No messages to compact")
  }

  const customInstructions = args.trim()

  try {
    // Try session memory compaction first if no custom instructions
    // (session memory compaction doesn't support custom instructions)
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(messages, context.agentId)
      if (sessionMemoryResult) {
        getUserContext.cache.clear?.()
        runPostCompactCleanup()
        // Reset cache read baseline so the post-compact drop isn't flagged
        // as a break. compactConversation does this internally; SM-compact doesn't.
        notifyCompaction(context.options.querySource ?? "compact", context.agentId)
        markPostCompaction()
        // Suppress warning immediately after successful compaction
        suppressCompactWarning()

        return {
          type: "compact",
          compactionResult: sessionMemoryResult,
          displayText: buildDisplayText({ summaryText: sessionMemoryResult.summaryText }),
        }
      }
    }

    // Fall back to traditional compaction
    // Run microcompact first to reduce tokens before summarization
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages

    const result = await compactConversation(
      messagesForCompact,
      context,
      await getCacheSharingParams(context, messagesForCompact),
      false,
      customInstructions,
      false,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)

    // Suppress the "Context left until auto-compact" warning after successful compaction
    suppressCompactWarning()

    getUserContext.cache.clear?.()
    runPostCompactCleanup()

    return {
      type: "compact",
      compactionResult: result,
      displayText: buildDisplayText({
        userDisplayMessage: result.userDisplayMessage,
        summaryText: result.summaryText,
      }),
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error("Compaction canceled.")
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    } else {
      logError(error)
      throw new Error(`Error during compaction: ${error}`)
    }
  }
}

export function buildDisplayText(options?: {
  userDisplayMessage?: string
  summaryText?: string
}): string {
  const upgradeMessage = getUpgradeMessage("tip")
  const parts = [
    ...(options?.userDisplayMessage ? [options.userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ]
  const prefix = chalk.dim(parts.length > 0 ? "Compacted " + parts.join("\n") : "Compacted")
  // The adapter's message-mapper extracts the marker into the structured
  // Message.compactSummary field, which the TUI renders as a collapsible
  // "Compaction Summary" fold. Any chalk ANSI codes are stripped downstream
  // by localCommandOutputToSDKAssistantMessage before the mapper runs.
  if (options?.summaryText !== undefined && options.summaryText !== "") {
    return `${prefix}\n<compact-summary>${options.summaryText}</compact-summary>`
  }
  return prefix
}

async function getCacheSharingParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
): Promise<{
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}> {
  const appState = context.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys()),
    context.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([getUserContext(), getSystemContext()])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}

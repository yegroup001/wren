import { randomUUID, type UUID } from "node:crypto"
import type { APIError } from "@anthropic-ai/sdk"
import type { BetaMessageDeltaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs"
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.mjs"
import type { NonNullableUsage } from "@wren/model-provider"
import { EMPTY_USAGE } from "@wren/model-provider"
import last from "lodash-es/last.js"
import { getSessionId, isSessionPersistenceDisabled } from "src/bootstrap/state.js"
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from "src/entrypoints/agentSdkTypes.js"
import { accumulateUsage, updateUsage } from "src/services/api/claude.js"
import type { AgentDefinition } from "src/tools/AgentTool/loadAgentsDir.js"
import { SYNTHETIC_OUTPUT_TOOL_NAME } from "src/tools/SyntheticOutputTool/SyntheticOutputTool.js"
import stripAnsi from "strip-ansi"
import type { Command } from "./commands.js"
import { getSlashCommandToolSkills } from "./commands.js"
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from "./constants/xml.js"
import { getModelUsage, getTotalAPIDuration, getTotalCost } from "./cost-tracker.js"
import type { CanUseToolFn } from "./hooks/useCanUseTool.js"
import { loadMemoryPrompt } from "./memdir/memdir.js"
import { hasAutoMemPathOverride } from "./memdir/paths.js"
import { query } from "./query.js"
import { categorizeRetryableAPIError } from "./services/api/errors.js"
import type { MCPServerConnection } from "./services/mcp/types.js"
import type { AppState } from "./state/AppState.js"
import {
  type CompactProgressEvent,
  type Tools,
  type ToolUseContext,
  toolMatchesName,
} from "./Tool.js"
import type { Message, SystemCompactBoundaryMessage } from "./types/message.js"
import type { OrphanedPermission } from "./types/textInputTypes.js"
import { createAbortController } from "./utils/abortController.js"
import type { AttributionState } from "./utils/commitAttribution.js"
import { getGlobalConfig } from "./utils/config.js"
import { getCwd } from "./utils/cwd.js"
import { isEnvTruthy } from "./utils/envUtils.js"
import { getFastModeState } from "./utils/fastMode.js"
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from "./utils/fileHistory.js"
import { cloneFileStateCache, type FileStateCache } from "./utils/fileStateCache.js"
import { headlessProfilerCheckpoint } from "./utils/headlessProfiler.js"
import { registerStructuredOutputEnforcement } from "./utils/hooks/hookHelpers.js"
import { getInMemoryErrors } from "./utils/log.js"
import { countToolCalls, SYNTHETIC_MESSAGES } from "./utils/messages.js"
import { getWrenConfigSafe } from "./utils/model/configBridge.js"
import { getMainLoopModel, parseUserSpecifiedModel } from "./utils/model/model.js"
import { loadAllPluginsCacheOnly } from "./utils/plugins/pluginLoader.js"
import {
  type ProcessUserInputContext,
  processUserInput,
} from "./utils/processUserInput/processUserInput.js"
import { fetchSystemPromptParts } from "./utils/queryContext.js"
import { setCwd } from "./utils/Shell.js"
import {
  flushSessionStorage,
  recordTranscript,
  removeTranscriptMessage,
} from "./utils/sessionStorage.js"
import { asSystemPrompt } from "./utils/systemPromptType.js"
import { resolveThemeSetting } from "./utils/systemTheme.js"
import { shouldEnableThinkingByDefault, type ThinkingConfig } from "./utils/thinking.js"
import { EngineHistorySnapshot } from "./wren/history-snapshot.js"

import { selectableUserMessagesFilter } from "./components/MessageSelector.js"

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from "./utils/messages/mappers.js"
import { buildSystemInitMessage, sdkCompatToolName } from "./utils/messages/systemInit.js"
import { getScratchpadDir, isScratchpadEnabled } from "./utils/permissions/filesystem.js"
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from "./utils/queryHelpers.js"

// Dead code elimination: conditional import for coordinator mode

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  /** MCP resources belonging to the same immutable tool/client snapshot. */
  mcpResources?: Record<string, import("./services/mcp/types.js").ServerResource[]>
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  sessionStorageContext?: import("./utils/sessionContext.js").SessionStorageContext
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** Optional request-scoped goal context appended to the system prompt. */
  getGoalContext?: () => string | undefined
  /** Handler for URL elicitations triggered by MCP tool -32042 errors. */
  handleElicitation?: ToolUseContext["handleElicitation"]
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /**
   * Returns true if the caller requested a graceful yield at the next
   * safe point (after tool results, before next LLM request). The query
   * loop checks this after tools complete and returns normally if set.
   * Unlike abort(), this does not abort in-flight API calls.
   */
  isYieldRequested?: () => boolean
  /**
   * Snip-boundary handler: receives each yielded system message plus the
   * current mutableMessages store. Returns undefined if the message is not a
   * snip boundary; otherwise returns the replayed snip result. Injected by
   * ask() when HISTORY_SNIP is enabled so feature-gated strings stay inside
   * the gated module (keeps QueryEngine free of excluded strings and testable
   * despite feature() returning false under bun test). SDK-only: the REPL
   * keeps full history for UI scrollback and projects on demand via
   * projectSnippedView; QueryEngine truncates here to bound memory in long
   * headless sessions (no UI to preserve).
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine owns the query lifecycle and session state for a conversation.
 * It extracts the core logic from ask() into a standalone class that can be
 * used by both the headless/SDK path and (in a future phase) the REPL.
 *
 * One QueryEngine per conversation. Each submitMessage() call starts a new
 * turn within the same conversation. State (messages, file cache, usage, etc.)
 * persists across turns.
 */
function hasUsage(usage: Readonly<NonNullableUsage>): boolean {
  return (
    usage.input_tokens > 0 ||
    usage.output_tokens > 0 ||
    usage.reasoning_tokens > 0 ||
    usage.cache_creation_input_tokens > 0 ||
    usage.cache_read_input_tokens > 0
  )
}

export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private readonly historyOwner = {}
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  // Turn-scoped skill discovery tracking (feeds was_discovered on
  // wren_skill_tool_invocation). Must persist across the two
  // processUserInputContext rebuilds inside submitMessage, but is cleared
  // at the start of each submitMessage to avoid unbounded growth across
  // many turns in SDK mode.
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()
  private yieldRequested = false

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      onCompactProgress,
      orphanedPermission,
      getGoalContext,
      mcpResources = {},
    } = this.config

    this.discoveredSkillNames.clear()
    this.permissionDenials = []
    this.yieldRequested = false
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    // Wrap canUseTool to track permission denials
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // Track denials for SDK reporting
      if (result.behavior === "deny") {
        this.permissionDenials.push({
          type: "permission_denial",
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: "adaptive" }
        : { type: "disabled" }

    headlessProfilerCheckpoint("before_getSystemPrompt")
    // Narrow once so TS tracks the type through the conditionals below.
    const customPrompt = typeof customSystemPrompt === "string" ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint("after_getSystemPrompt")
    const userContext = {
      ...baseUserContext,
    }

    // When an SDK caller provides a custom system prompt AND has set
    // WREN_COWORK_MEMORY_PATH_OVERRIDE, inject the memory-mechanics prompt.
    // The env var is an explicit opt-in signal — the caller has wired up
    // a memory directory and needs Wren to know how to use it (which
    // Write/Edit tools to call, MEMORY.md filename, loading semantics).
    // The caller can layer their own policy text via appendSystemPrompt.
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride() ? await loadMemoryPrompt() : null

    const goalContext = getGoalContext?.()
    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
      ...(goalContext !== undefined ? [goalContext] : []),
    ])

    // Register function hook for structured output enforcement
    const hasStructuredOutputTool = tools.some((t) =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // Slash commands that mutate the message array (e.g. /force-snip)
      // call setMessages(fn).  In interactive mode this writes back to
      // AppState; in print mode we write back to mutableMessages so the
      // rest of the query loop (push at :389, snapshot at :392) sees
      // the result.  The second processUserInputContext below (after
      // slash-command processing) keeps the no-op — nothing else calls
      // setMessages past that point.
      setMessages: (fn) => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources,
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getWrenConfigSafe()?.theme ?? getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      sessionStorageContext: this.config.sessionStorageContext,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => {
        setAppState((prev) => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (updater: (prev: AttributionState) => AttributionState) => {
        setAppState((prev) => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
      onCompactProgress,
    }

    // Handle orphaned permission (only once per engine lifetime)
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: "prompt",
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: "sdk",
    })

    // Push new messages, including user input and any attachments
    this.mutableMessages.push(...messagesFromUserInput)

    // Update params to reflect updates from processing /slash commands
    const messages = [...this.mutableMessages]

    // Persist the user's message(s) to transcript BEFORE entering the query
    // loop. The for-await below only calls recordTranscript when ask() yields
    // an assistant/user/compact_boundary message — which doesn't happen until
    // the API responds. If the process is killed before that (e.g. user clicks
    // Stop in cowork seconds after send), the transcript is left with only
    // queue-operation entries; getLastSessionLog filters those out, returns
    // null, and --resume fails with "No conversation found". Writing now makes
    // the transcript resumable from the point the user message was accepted,
    // even if no API response ever arrives.
    //
    if (persistSession && messagesFromUserInput.length > 0) {
      await recordTranscript(messages)
      if (isEnvTruthy(process.env.WREN_EAGER_FLUSH) || isEnvTruthy(process.env.WREN_IS_COWORK)) {
        await flushSessionStorage()
      }
    }

    // Filter messages that should be acknowledged after transcript
    const replayableMessages = messagesFromUserInput.filter(
      (msg) =>
        (msg.type === "user" &&
          !msg.isMeta && // Skip synthetic caveat messages
          !msg.toolUseResult && // Skip tool results (they'll be acked from query)
          (selectableUserMessagesFilter(msg) ?? true)) || // Skip non-user-authored messages (task notifications, etc.)
        (msg.type === "system" && msg.subtype === "compact_boundary"), // Always ack compact boundaries
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // Update the ToolPermissionContext based on user input processing (as necessary)
    setAppState((prev) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // Recreate after processing the prompt to pick up updated messages and
    // model (from slash commands).
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources,
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getWrenConfigSafe()?.theme ?? getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      sessionStorageContext: this.config.sessionStorageContext,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
      onCompactProgress,
    }

    headlessProfilerCheckpoint("before_skills_plugins")
    // Cache-only: headless/SDK/CCR startup must not block on network for
    // ref-tracked plugins. CCR populates the cache via WREN_SYNC_PLUGIN_INSTALL
    // (headlessPluginInstall) or WREN_PLUGIN_SEED_DIR before this runs;
    // SDK callers that need fresh source can call /reload-plugins.
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint("after_skills_plugins")

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext.mode as PermissionMode, // TODO: avoid the cast
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // Record when system message is yielded for headless latency tracking
    headlessProfilerCheckpoint("system_message_yielded")

    if (!shouldQuery) {
      // A manual compact replaces the engine's context at its boundary, just
      // like the query loop does for automatic compaction. Drop the old prefix
      // before persisting the snapshot so repeated /compact calls do not retain
      // every pre-compaction message in memory.
      const compactBoundaryIndex = this.mutableMessages.findLastIndex(
        (message) => message.type === "system" && message.subtype === "compact_boundary",
      )
      if (compactBoundaryIndex >= 0) {
        this.mutableMessages.splice(0, compactBoundaryIndex)
        const localBoundaryIndex = messages.findLastIndex(
          (message) => message.type === "system" && message.subtype === "compact_boundary",
        )
        if (localBoundaryIndex >= 0) messages.splice(0, localBoundaryIndex)
      }

      // Return the results of local slash commands.
      // Use messagesFromUserInput (not replayableMessages) for command output
      // because selectableUserMessagesFilter excludes local-command-stdout tags.
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === "user" &&
          typeof msg.message!.content === "string" &&
          (msg.message!.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message!.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: "user",
            message: {
              ...msg.message,
              content: stripAnsi(msg.message!.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as unknown as SDKUserMessageReplay
        }

        // Local command output — yield as a synthetic assistant message so
        // RC renders it as assistant-style text rather than a user bubble.
        // Emitted as assistant (not the dedicated SDKLocalCommandOutputMessage
        // system subtype) so mobile clients + session-ingress can parse it.
        if (
          msg.type === "system" &&
          msg.subtype === "local_command" &&
          typeof msg.content === "string" &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          const compactMsg = msg as SystemCompactBoundaryMessage
          yield {
            type: "system",
            subtype: "compact_boundary" as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(compactMsg.compactMetadata),
          } as unknown as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (isEnvTruthy(process.env.WREN_EAGER_FLUSH) || isEnvTruthy(process.env.WREN_IS_COWORK)) {
          await flushSessionStorage()
        }
      }

      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? "",
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(mainLoopModel, initialAppState.fastMode),
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      const _filter = selectableUserMessagesFilter ?? ((_msg: unknown) => true)
      messagesFromUserInput.filter(_filter).forEach((message) => {
        void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
          setAppState((prev) => ({
            ...prev,
            fileHistory: updater(prev.fileHistory),
          }))
        }, message.uuid)
      })
    }

    // Track current message usage (reset on each message_start)
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let currentMessageUsageAccounted = false
    let turnCount = 1
    let hasAcknowledgedInitialMessages = false
    // Track structured output from StructuredOutput tool calls
    let structuredOutputFromTool: unknown
    // Track the last stop_reason from assistant messages
    let lastStopReason: string | null = null
    // Reference-based watermark so error_during_execution's errors[] is
    // turn-scoped. A length-based index breaks when the 100-entry ring buffer
    // shift()s during the turn — the index slides. If this entry is rotated
    // out, lastIndexOf returns -1 and we include everything (safe fallback).
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // Snapshot count before this query for delta-based retry limiting
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: "sdk",
      maxTurns,
      taskBudget,
      isYieldRequested: this.config.isYieldRequested,
    })) {
      // Record assistant, user, and compact boundary messages
      if (
        message.type === "assistant" ||
        message.type === "user" ||
        (message.type === "system" && message.subtype === "compact_boundary")
      ) {
        // Before writing a compact boundary, flush any in-memory-only
        // messages up through the preservedSegment tail. Attachments and
        // progress are now recorded inline (their switch cases below), but
        // this flush still matters for the preservedSegment tail walk.
        // If the SDK subprocess restarts before then (claude-desktop kills
        // between turns), tailUuid points to a never-written message →
        // applyPreservedSegmentRelinks fails its tail→head walk → returns
        // without pruning → resume loads full pre-compact history.
        if (persistSession && message.type === "system" && message.subtype === "compact_boundary") {
          const compactMsg = message as SystemCompactBoundaryMessage
          const tailUuid = compactMsg.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex((m) => m.uuid === tailUuid)
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message as Message)
        if (persistSession) {
          // Fire-and-forget for assistant messages. claude.ts yields one
          // assistant message per content block, then mutates the last
          // one's message.usage/stop_reason on message_delta — relying on
          // the write queue's 100ms lazy jsonStringify. Awaiting here
          // blocks ask()'s generator, so message_delta can't run until
          // every block is consumed; the drain timer (started at block 1)
          // elapses first. Interactive CC doesn't hit this because
          // useLogMessages.ts fire-and-forgets. enqueueWrite is
          // order-preserving so fire-and-forget here is safe.
          if (message.type === "assistant") {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // Acknowledge initial user messages after first transcript recording
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === "user") {
              yield {
                type: "user",
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as unknown as SDKUserMessageReplay
            }
          }
        }
      }

      if (message.type === "user") {
        turnCount++
      }

      switch (message.type) {
        case "tombstone": {
          const tombstoneMsg = message as unknown as { message?: { uuid?: string } }
          const targetUuid = tombstoneMsg.message?.uuid
          if (targetUuid) {
            void removeTranscriptMessage(targetUuid as UUID)
          }
          break
        }
        case "assistant": {
          // Capture stop_reason if already set (synthetic messages). For
          // streamed responses, this is null at content_block_stop time;
          // the real value arrives via message_delta (handled below).
          const msg = message as Message
          const stopReason = msg.message?.stop_reason as string | null | undefined
          if (stopReason != null) {
            lastStopReason = stopReason
          }
          // Non-streaming fallback: the AssistantMessage carries usage
          // directly, but no message_start/message_delta/message_stop
          // stream events were emitted. Accumulate it here to avoid
          // losing token counts.
          if (!currentMessageUsageAccounted && msg.message?.usage) {
            const msgUsage = msg.message.usage as BetaMessageDeltaUsage
            const candidate = updateUsage(EMPTY_USAGE, msgUsage)
            if (hasUsage(candidate)) {
              currentMessageUsage = candidate
              this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
              currentMessageUsageAccounted = true
            }
          }
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case "progress": {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // Record inline so the dedup loop in the next ask() call sees it
          // as already-recorded. Without this, deferred progress interleaves
          // with already-recorded tool_results in mutableMessages, and the
          // dedup walk freezes startingParentUuid at the wrong message —
          // forking the chain and orphaning the conversation on resume.
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(msg)
          break
        }
        case "user": {
          const msg = message as Message
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case "stream_event": {
          const event = (message as unknown as { event: Record<string, unknown> }).event
          if (event.type === "message_start") {
            // Reset current message usage for new message
            currentMessageUsage = EMPTY_USAGE
            currentMessageUsageAccounted = false
            const eventMessage = event.message as {
              usage: BetaMessageDeltaUsage
            }
            currentMessageUsage = updateUsage(currentMessageUsage, eventMessage.usage)
          }
          if (event.type === "message_delta") {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              event.usage as BetaMessageDeltaUsage,
            )
            // Capture stop_reason from message_delta. The assistant message
            // is yielded at content_block_stop with stop_reason=null; the
            // real value only arrives here (see claude.ts message_delta
            // handler). Without this, result.stop_reason is always null.
            const delta = event.delta as { stop_reason?: string | null }
            if (delta.stop_reason != null) {
              lastStopReason = delta.stop_reason
            }
          }
          if (event.type === "message_stop" && !currentMessageUsageAccounted) {
            // Accumulate current message usage into total exactly once.
            this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
            currentMessageUsageAccounted = true
          }

          if (includePartialMessages) {
            yield {
              type: "stream_event" as const,
              event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        }
        case "attachment": {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // Record inline (same reason as progress above).
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }

          const attachment = msg.attachment as {
            type: string
            data?: unknown
            turnCount?: number
            maxTurns?: number
            prompt?: string
            source_uuid?: string
            [key: string]: unknown
          }

          // Extract structured output from StructuredOutput tool calls
          if (attachment.type === "structured_output") {
            structuredOutputFromTool = attachment.data
          }
          // Handle max turns reached signal from query.ts
          else if (attachment.type === "max_turns_reached") {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.WREN_EAGER_FLUSH) ||
                isEnvTruthy(process.env.WREN_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: "result",
              subtype: "error_max_turns",
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: attachment.turnCount as number,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(mainLoopModel, initialAppState.fastMode),
              uuid: randomUUID(),
              errors: [`Reached maximum number of turns (${attachment.maxTurns})`],
            }
            return
          }
          // Yield queued_command attachments as SDK user message replays
          else if (replayUserMessages && attachment.type === "queued_command") {
            yield {
              type: "user",
              message: {
                role: "user" as const,
                content: attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: attachment.source_uuid || msg.uuid,
              timestamp: msg.timestamp,
              isReplay: true,
            } as unknown as SDKUserMessageReplay
          }
          break
        }
        case "stream_request_start":
          // Don't yield stream request start messages
          break
        case "system": {
          const msg = message as Message
          // Snip boundary: replay on our store to remove zombie messages and
          // stale markers. The yielded boundary is a signal, not data to push —
          // the replay produces its own equivalent boundary. Without this,
          // markers persist and re-trigger on every turn, and mutableMessages
          // never shrinks (memory leak in long SDK sessions). The subtype
          // check lives inside the injected callback so feature-gated strings
          // stay out of this file (excluded-strings check).
          const snipResult = this.config.snipReplay?.(msg, this.mutableMessages)
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(msg)
          // Yield compact boundary messages to SDK
          if (msg.subtype === "compact_boundary" && msg.compactMetadata) {
            const compactMsg = msg as SystemCompactBoundaryMessage
            // Release pre-compaction messages for GC. The boundary was just
            // pushed so it's the last element. query.ts already uses
            // getMessagesAfterCompactBoundary() internally, so only
            // post-boundary messages are needed going forward.
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: "system",
              subtype: "compact_boundary" as const,
              session_id: getSessionId(),
              uuid: msg.uuid,
              compact_metadata: toSDKCompactMetadata(compactMsg.compactMetadata),
            }
          }
          if (msg.subtype === "api_error") {
            const apiErrorMsg = msg as Message & {
              retryAttempt: number
              maxRetries: number
              retryInMs: number
              error: APIError
            }
            yield {
              type: "system",
              subtype: "api_retry" as const,
              attempt: apiErrorMsg.retryAttempt,
              max_retries: apiErrorMsg.maxRetries,
              retry_delay_ms: apiErrorMsg.retryInMs,
              error_status: apiErrorMsg.error.status ?? null,
              error: categorizeRetryableAPIError(apiErrorMsg.error),
              session_id: getSessionId(),
              uuid: msg.uuid,
            }
          }
          // Don't yield other system messages in headless mode
          break
        }
        case "tool_use_summary": {
          const msg = message as Message & {
            summary: unknown
            precedingToolUseIds: unknown
          }
          // Yield tool use summary messages to SDK
          yield {
            type: "tool_use_summary" as const,
            summary: msg.summary,
            preceding_tool_use_ids: msg.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: msg.uuid,
          }
          break
        }
      }

      // Check if USD budget has been exceeded
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.WREN_EAGER_FLUSH) ||
            isEnvTruthy(process.env.WREN_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: "result",
          subtype: "error_max_budget_usd",
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(mainLoopModel, initialAppState.fastMode),
          uuid: randomUUID(),
          errors: [
            `Reached maximum budget ($${maxBudgetUsd}). Increase the limit with --max-budget-usd or start a new session.`,
          ],
        }
        return
      }

      // Check if structured output retry limit exceeded (only on user messages)
      if (message.type === "user" && jsonSchema) {
        const currentCalls = countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(process.env.MAX_STRUCTURED_OUTPUT_RETRIES || "5", 10)
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.WREN_EAGER_FLUSH) ||
              isEnvTruthy(process.env.WREN_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: "result",
            subtype: "error_max_structured_output_retries",
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(mainLoopModel, initialAppState.fastMode),
            uuid: randomUUID(),
            errors: [`Failed to provide valid structured output after ${maxRetries} attempts`],
          }
          return
        }
      }
    }

    // Stop hooks yield progress/attachment messages AFTER the assistant
    // response (via yield* handleStopHooks in query.ts). Since #23537 pushes
    // those to `messages` inline, last(messages) can be a progress/attachment
    // instead of the assistant — which makes textResult extraction below
    // return '' and -p mode emit a blank line. Allowlist to assistant|user:
    // isResultSuccessful handles both (user with all tool_result blocks is a
    // valid successful terminal state).
    const result = messages.findLast((m) => m.type === "assistant" || m.type === "user")
    // Capture for the error_during_execution diagnostic — isResultSuccessful
    // is a type predicate (message is Message), so inside the false branch
    // `result` narrows to never and these accesses don't typecheck.
    const edeResultType = result?.type ?? "undefined"
    const edeLastContentType =
      result?.type === "assistant"
        ? (last(
            result.message!
              .content as import("@anthropic-ai/sdk/resources/beta/messages/messages.js").BetaContentBlock[],
          )?.type ?? "none")
        : "n/a"

    // Flush buffered transcript writes before yielding result.
    // The desktop app kills the CLI process immediately after receiving the
    // result message, so any unflushed writes would be lost.
    if (persistSession) {
      if (isEnvTruthy(process.env.WREN_EAGER_FLUSH) || isEnvTruthy(process.env.WREN_IS_COWORK)) {
        await flushSessionStorage()
      }
    }

    const wasInterrupted = this.abortController.signal.aborted
    // A provider can end after emitting content and usage but before message_stop.
    // Preserve that partial usage for both successful and interrupted terminal results,
    // unless message_stop (or the fallback path in case "assistant") has already
    // accounted for this response.
    if (!currentMessageUsageAccounted && hasUsage(currentMessageUsage)) {
      this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
      currentMessageUsageAccounted = true
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      // If the abort signal fired, the result is incomplete because the
      // user interrupted (Ctrl+C) — not because of an execution error.
      // Yield a clear "interrupted" message instead of the raw diagnostic.
      yield {
        type: "result",
        subtype: "error_during_execution",
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(mainLoopModel, initialAppState.fastMode),
        uuid: randomUUID(),
        errors: (() => {
          if (wasInterrupted) {
            return ["Interrupted by user"]
          }
          // Diagnostic prefix: these are what isResultSuccessful() checks — if
          // the result type isn't assistant-with-text/thinking or user-with-
          // tool_result, and stop_reason isn't end_turn, that's why this fired.
          // errors[] is turn-scoped via the watermark; previously it dumped the
          // entire process's logError buffer (ripgrep timeouts, ENOENT, etc).
          const all = getInMemoryErrors()
          const start = errorLogWatermark ? all.lastIndexOf(errorLogWatermark) + 1 : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map((_) => _.error),
          ]
        })(),
      }
      return
    }

    // Extract the text result based on message type
    let textResult = ""
    let isApiError = false

    if (result.type === "assistant") {
      const lastContent = last(
        result.message!
          .content as import("@anthropic-ai/sdk/resources/beta/messages/messages.js").BetaContentBlock[],
      )
      if (lastContent?.type === "text" && !SYNTHETIC_MESSAGES.has(lastContent.text)) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    yield {
      type: "result",
      subtype: "success",
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(mainLoopModel, initialAppState.fastMode),
      uuid: randomUUID(),
    }
  }

  interrupt(): void {
    this.abortController.abort()
  }

  /**
   * Request the current query loop to yield gracefully at the next safe
   * point (after tool results are yielded, before the next LLM request).
   * Unlike interrupt(), this does NOT abort in-flight API calls or
   * trigger error-handling paths — the loop simply returns normally.
   */
  requestYield(): void {
    this.yieldRequested = true
  }

  /** Clear the yield-requested flag so the next submitMessage starts fresh. */
  resetYieldRequest(): void {
    this.yieldRequested = false
  }

  /** Reset the abort controller so the next submitMessage() call can start
   *  with a fresh, non-aborted signal. Must be called after interrupt(). */
  resetAbortController(): void {
    this.abortController = createAbortController()
  }

  isYieldRequested(): boolean {
    return this.yieldRequested
  }

  /** Expose the current abort signal for external consumers (e.g. ACP bridge). */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  snapshotHistory(): EngineHistorySnapshot {
    return EngineHistorySnapshot.capture(this.historyOwner, this.mutableMessages, (messages) => {
      this.mutableMessages = [...messages]
    })
  }

  restoreHistory(snapshot: EngineHistorySnapshot): void {
    snapshot.restoreFor(this.historyOwner)
  }

  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }

  truncateMessages(count: number): void {
    if (count < 0) return
    if (count >= this.mutableMessages.length) return
    this.mutableMessages = this.mutableMessages.slice(0, count)
  }
}

/**
 * Sends a single prompt to the model API and returns the response.
 * Assumes that claude is being used non-interactively -- will not
 * ask the user for permissions or further input.
 *
 * Convenience wrapper around QueryEngine for one-shot usage.
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  onCompactProgress,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext["handleElicitation"]
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents: agents ?? [],
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    onCompactProgress,
    abortController,
    orphanedPermission,
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}

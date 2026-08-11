import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs"

export type { ToolResultBlockParam }

import type { UUID } from "node:crypto"
import type { ElicitRequestURLParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import type { z } from "zod/v4"
import type { Command } from "./commands.js"
import type { CanUseToolFn } from "./hooks/useCanUseTool.js"
import type { ThinkingConfig } from "./utils/thinking.js"

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: "object"
  properties?: {
    [x: string]: unknown
  }
}

/** Chain tracking for nested queries (chainId + depth), propagated through
 *  tool use context and API options. */
export type QueryChainTracking = {
  chainId: string
  depth: number
}

import type { AgentDefinition, AgentDefinitionsResult } from "src/tools/AgentTool/loadAgentsDir.js"
import type { SpinnerMode } from "./components/Spinner/index.js"
import type { QuerySource } from "./constants/querySource.js"
import type { SDKStatus } from "./entrypoints/agentSdkTypes.js"
import type { MCPServerConnection, ServerResource } from "./services/mcp/types.js"
import type { AppState } from "./state/AppState.js"
import type { HookProgress, PromptRequest, PromptResponse } from "./types/hooks.js"
import type { AgentId } from "./types/ids.js"
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from "./types/message.js"
// Import permission types from centralized location to break import cycles
// Import PermissionResult from centralized location to break import cycles
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from "./types/permissions.js"
// Import tool progress types from centralized location to break import cycles
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from "./types/tools.js"
import type { DeepImmutable } from "./types/utils.js"
import type { AttributionState } from "./utils/commitAttribution.js"
import type { FileHistoryState } from "./utils/fileHistory.js"
import type { FileStateCache } from "./utils/fileStateCache.js"
import type { DenialTrackingState } from "./utils/permissions/denialTracking.js"
import type { SessionStorageContext } from "./utils/sessionContext.js"
import type { SystemPrompt } from "./utils/systemPromptType.js"
import type { ContentReplacementState } from "./utils/toolResultStorage.js"

export type ToolNotification = {
  key: string
  text: string
  priority: "immediate" | "normal"
  color?: "error" | "warning" | "info"
  timeoutMs?: number
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type SetToolJSXFn = (
  args: {
    jsx: unknown | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    isImmediate?: boolean
    /** Set to true to clear a local JSX command (e.g., from its onDone callback) */
    clearLocalJSX?: boolean
  } | null,
) => void

// Import tool permission types from centralized location to break import cycles
import type { ToolPermissionRulesBySource } from "./types/permissions.js"

// Re-export for backwards compatibility
export type { ToolPermissionRulesBySource }

// Apply DeepImmutable to the imported type
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isFullModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  /** When true, permission prompts are auto-denied (e.g., background agents that can't show UI) */
  shouldAvoidPermissionPrompts?: boolean
  /** When true, automated checks (classifier, hooks) are awaited before showing the permission dialog (coordinator workers) */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** Stores the permission mode before plan mode entry so it can be restored on exit */
  prePlanMode?: PermissionMode
  /** Requires user approval when the main thread exits plan mode */
  planExitApprovalRequired?: boolean
}>

export const getEmptyToolPermissionContext: () => ToolPermissionContext = () => ({
  mode: "default",
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isFullModeAvailable: true,
})

export type CompactProgressEvent =
  | {
      type: "hooks_start"
      hookType: "pre_compact" | "post_compact" | "session_start"
    }
  | { type: "compact_start" }
  | { type: "compact_end" }
  | { type: "summary_delta"; text: string }
  | { type: "thinking_delta"; text: string }

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    /** Custom system prompt that replaces the default system prompt */
    customSystemPrompt?: string
    /** Additional system prompt appended after the main system prompt */
    appendSystemPrompt?: string
    /** Override querySource for analytics tracking */
    querySource?: QuerySource
    /** Optional callback to get the latest tools (e.g., after MCP servers connect mid-query) */
    refreshTools?: () => Tools
    /**
     * @internal TEST-ONLY ESCAPE HATCH. MUST remain undefined in production.
     *
     * Allows non-bundled unit-test harnesses to exercise the background
     * forked slash command path that production assistant mode gates behind
     * `false`. Still requires `AppState.kairosEnabled`. This
     * field is constructed in-process by trusted application code only;
     * no external surface (MCP, plugin, slash command, network) writes to
     * `ToolUseContext.options`. Setting this true outside a test bypasses
     * the KAIROS feature flag; `processSlashCommand` rejects this flag
     * outside `NODE_ENV=test`.
     */
    allowBackgroundForkedSlashCommands?: boolean
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  /**
   * Always-shared setAppState for session-scoped infrastructure (background
   * tasks, session hooks). Unlike setAppState, which is no-op for async agents
   * (see createSubagentContext), this always reaches the root store so agents
   * at any nesting depth can register/clean up infrastructure that outlives
   * a single turn. Only set by createSubagentContext; main-thread contexts
   * fall back to setAppState.
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * Optional handler for URL elicitations triggered by tool call errors (-32042).
   * In print/SDK mode, this delegates to structuredIO.handleElicitation.
   * In REPL mode, this is undefined and the queue-based UI path is used.
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: ToolNotification) => void
  /** Append a UI-only system message to the REPL message list. Stripped at the
   *  normalizeMessagesForAPI boundary — the Exclude<> makes that type-enforced. */
  appendSystemMessage?: (msg: Exclude<SystemMessage, SystemLocalCommandMessage>) => void
  /** Send an OS-level notification (iTerm2, Kitty, Ghostty, bell, etc.) */
  sendOSNotification?: (opts: { message: string; notificationType: string }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * WREN.md paths already injected as nested_memory attachments this
   * session. Dedup for memoryFilesToAttachments — readFileState is an LRU
   * that evicts entries in busy sessions, so its .has() check alone can
   * re-inject the same WREN.md dozens of times.
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  /** Skill names surfaced via skill_discovery this session. Telemetry only (feeds was_discovered). */
  discoveredSkillNames?: Set<string>
  userModified?: boolean
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** Only wired in interactive (REPL) contexts; SDK/QueryEngine don't set this. */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void
  /** Ant-only: push a new API metrics entry for OTPS tracking.
   *  Called by subagent streaming when a new API request starts. */
  pushApiMetricsEntry?: (ttftMs: number) => void
  setStreamMode?: (mode: SpinnerMode) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: SDKStatus) => void
  openMessageSelector?: () => void
  updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => void
  updateAttributionState: (updater: (prev: AttributionState) => AttributionState) => void
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // Only set for subagents; use getSessionId() for session ID. Hooks use this to distinguish subagent calls.
  agentType?: string // Subagent type name. For the main thread's --agent type, hooks fall back to getMainThreadAgentType().
  /** When true, canUseTool must always be called even when hooks auto-approve.
   *  Used by speculation for overlay file path rewriting. */
  requireCanUseTool?: boolean
  messages: Message[]
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: "accept" | "reject"
      timestamp: number
    }
  >
  queryTracking?: QueryChainTracking
  /** Callback factory for requesting interactive prompts from the user.
   * Returns a prompt callback bound to the given source name.
   * Only available in interactive (REPL) contexts. */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** When true, preserve toolUseResult on messages even for subagents.
   * Used by in-process teammates whose transcripts are viewable by the user. */
  preserveToolUseResults?: boolean
  /** Explicit session context for durable sidechain transcript writes. */
  sessionStorageContext?: SessionStorageContext
  /** Local denial tracking state for async subagents whose setAppState is a
   *  no-op. Without this, the denial counter never accumulates and the
   *  fallback-to-prompting threshold is never reached. Mutable — the
   *  permissions code updates it in place. */
  localDenialTracking?: DenialTrackingState
  /**
   * Per-conversation-thread content replacement state for the tool result
   * budget. When present, query.ts applies the aggregate tool result budget.
   * Main thread: REPL provisions once (never resets — stale UUID keys
   * are inert). Subagents: createSubagentContext clones the parent's state
   * by default (cache-sharing forks need identical decisions), or
   * resumeAgentBackground threads one reconstructed from sidechain records.
   */
  contentReplacementState?: ContentReplacementState
  /**
   * Parent's rendered system prompt bytes, frozen at turn start.
   * Used by fork subagents to share the parent's prompt cache — re-calling
   * getSystemPrompt() at fork-spawn time can diverge (feature gate cold→warm)
   * and bust the cache. See forkSubagent.ts.
   */
  renderedSystemPrompt?: SystemPrompt
}

// Re-export ToolProgressData from centralized location
export type { ToolProgressData }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      (msg.data as { type?: string })?.type !== "hook_progress",
  )
}

export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  // contextModifier is only honored for tools that aren't concurrency safe.
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP protocol metadata (structuredContent, _meta) to pass through to SDK consumers */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// Type for any schema that outputs an object with string keys
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * Checks if a tool matches the given name (primary name or alias).
 */
export function toolMatchesName(tool: { name: string; aliases?: string[] }, name: string): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

/**
 * Finds a tool by name or alias from a list of tools.
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find((t) => toolMatchesName(t, name))
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /**
   * Optional aliases for backwards compatibility when a tool is renamed.
   * The tool can be looked up by any of these names in addition to its primary name.
   */
  aliases?: string[]
  /**
   * One-line capability phrase used by SearchExtraTools for keyword matching.
   * Helps the model find this tool via keyword search when it's deferred.
   * 3–10 words, no trailing period.
   * Prefer terms not already in the tool name (e.g. 'jupyter' for NotebookEdit).
   */
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  // Type for MCP tools that can specify their input schema directly in JSON Schema format
  // rather than converting from Zod schema
  readonly inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: z.ZodType<unknown>
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  /** Defaults to false. Only set when the tool performs irreversible operations (delete, overwrite, send). */
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * What should happen when the user submits a new message while this tool
   * is running.
   *
   * - `'cancel'` — stop the tool and discard its result
   * - `'block'`  — keep running; the new message waits
   *
   * Defaults to `'block'` when not implemented.
   */
  interruptBehavior?(): "cancel" | "block"
  /**
   * Returns information about whether this tool use is a search or read operation
   * that should be collapsed into a condensed display in the UI. Examples include
   * file searching (Grep, Glob), file reading (Read), and bash commands like find,
   * grep, wc, etc.
   *
   * Returns an object indicating whether the operation is a search or read operation:
   * - `isSearch: true` for search operations (grep, find, glob patterns)
   * - `isRead: true` for read operations (cat, head, tail, file read)
   * - `isList: true` for directory-listing operations (ls, tree, du)
   * - All can be false if the operation shouldn't be collapsed
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  /**
   * When true, this tool is deferred (sent with defer_loading: true) and requires
   * SearchExtraTools to be used before it can be called.
   */
  readonly shouldDefer?: boolean
  /**
   * When true, this tool is never deferred — its full schema appears in the
   * initial prompt even when SearchExtraTools is enabled. For MCP tools, set via
   * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
   * turn 1 without a SearchExtraTools round-trip.
   */
  readonly alwaysLoad?: boolean
  /**
   * For MCP tools: the server and tool names as received from the MCP server (unnormalized).
   * Present on all MCP tools regardless of whether `name` is prefixed (mcp__server__tool).
   */
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string
  /**
   * Maximum size in characters for tool result before it gets persisted to disk.
   * When exceeded, the result is saved to a file and Wren receives a preview
   * with the file path instead of the full content.
   *
   * Set to Infinity for tools whose output must never be persisted (e.g. Read,
   * where persisting creates a circular Read→file→Read loop and the tool
   * already self-bounds via its own limits).
   */
  maxResultSizeChars: number
  /**
   * When true, enables strict mode for this tool, which causes the API to
   * more strictly adhere to tool instructions and parameter schemas.
   * Only applied when the wren_tool_pear is enabled.
   */
  readonly strict?: boolean

  /**
   * Called on copies of tool_use input before observers see it (SDK stream,
   * transcript, canUseTool, PreToolUse/PostToolUse hooks). Mutate in place
   * to add legacy/derived fields. Must be idempotent. The original API-bound
   * input is never mutated (preserves prompt cache). Not re-applied when a
   * hook/permission returns a fresh updatedInput — those own their shape.
   */
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * Determines if this tool is allowed to run with this input in the current context.
   * It informs the model of why the tool use failed, and does not directly display any UI.
   * @param input
   * @param context
   */
  validateInput?(input: z.infer<Input>, context: ToolUseContext): Promise<ValidationResult>

  /**
   * Determines if the user is asked for permission. Only called after validateInput() passes.
   * General permission logic is in permissions.ts. This method contains tool-specific logic.
   * @param input
   * @param context
   */
  checkPermissions(input: z.infer<Input>, context: ToolUseContext): Promise<PermissionResult>

  // Optional method for tools that operate on a file path
  getPath?(input: z.infer<Input>): string

  /**
   * Prepare a matcher for hook `if` conditions (permission-rule patterns like
   * "git *" from "Bash(git *)"). Called once per hook-input pair; any
   * expensive parsing happens here. Returns a closure that is called per
   * hook pattern. If not implemented, only tool-name-level matching works.
   */
  preparePermissionMatcher?(input: z.infer<Input>): Promise<(pattern: string) => boolean>

  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  /**
   * Returns a short string summary of this tool use for display in compact views.
   * @param input The tool input
   * @returns A short string summary, or null to not display
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * Returns a human-readable present-tense activity description for spinner display.
   * Example: "Reading src/foo.ts", "Running bun test", "Searching for pattern"
   * @param input The tool input
   * @returns Activity description string, or null to fall back to tool name
   */
  getActivityDescription?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * Returns a compact representation of this tool use for the auto-mode
   * security classifier. Examples: `ls -la` for Bash, `/tmp/x: new content`
   * for Edit. Return '' to skip this tool in the classifier transcript
   * (e.g. tools with no security relevance). May return an object to avoid
   * double-encoding when the caller JSON-wraps the value.
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string): ToolResultBlockParam
  /**
   * Flattened text of what the tool result renders in transcript mode.
   * For transcript search indexing: the index counts occurrences in this
   * string, the highlight overlay scans the actual screen buffer. For count
   * ≡ highlight, this must return the text that ends up visible — not the
   * model-facing serialization from mapToolResultToToolResultBlockParam.
   * Optional: omitted → field-name heuristic in transcriptSearch.ts.
   */
  extractSearchText?(out: Output): string
}

/**
 * A collection of tools. Use this type instead of `Tool[]` to make it easier
 * to track where tool sets are assembled, passed, and filtered across the codebase.
 */
export type Tools = readonly Tool[]

/**
 * Methods that `buildTool` supplies a default for. A `ToolDef` may omit these;
 * the resulting `Tool` always has them.
 */
type DefaultableToolKeys =
  | "isEnabled"
  | "isConcurrencySafe"
  | "isReadOnly"
  | "isDestructive"
  | "checkPermissions"
  | "toAutoClassifierInput"
  | "userFacingName"

/**
 * Tool definition accepted by `buildTool`. Same shape as `Tool` but with the
 * defaultable methods optional — `buildTool` fills them in so callers always
 * see a complete `Tool`.
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * Type-level spread mirroring `{ ...TOOL_DEFAULTS, ...def }`. For each
 * defaultable key: if D provides it (required), D's type wins; if D omits
 * it or has it optional (inherited from Partial<> in the constraint), the
 * default fills in. All other keys come from D verbatim — preserving arity,
 * optional presence, and literal types exactly as `satisfies Tool` did.
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * Build a complete `Tool` from a partial definition, filling in safe defaults
 * for the commonly-stubbed methods. All tool exports should go through this so
 * that defaults live in one place and callers never need `?.() ?? default`.
 *
 * Defaults (fail-closed where it matters):
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false` (assume not safe)
 * - `isReadOnly` → `false` (assume writes)
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }` (defer to general permission system)
 * - `toAutoClassifierInput` → `''` (skip classifier — security-relevant tools must override)
 * - `userFacingName` → `name`
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> => Promise.resolve({ behavior: "allow", updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => "",
  userFacingName: (_input?: unknown) => "",
}

// The defaults type is the ACTUAL shape of TOOL_DEFAULTS (optional params so
// both 0-arg and full-arg call sites type-check — stubs varied in arity and
// tests relied on that), not the interface's strict signatures.
type ToolDefaults = typeof TOOL_DEFAULTS

// D infers the concrete object-literal type from the call site. The
// constraint provides contextual typing for method parameters; `any` in
// constraint position is structural and never leaks into the return type.
// BuiltTool<D> mirrors runtime `{...TOOL_DEFAULTS, ...def}` at the type level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // The runtime spread is straightforward; the `as` bridges the gap between
  // the structural-any constraint and the precise BuiltTool<D> return. The
  // type semantics are proven by the 0-error typecheck across all 60+ tools.
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}

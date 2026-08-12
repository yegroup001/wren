/**
 * Engine wrapper.
 *
 * Instantiates the real {@link QueryEngine} with real tools, real model
 * selection, and a `canUseTool` callback. Replaces the previous mock fixture
 * engine (preserved in `src.mock-backup/`).
 *
 * The wrapper exposes a narrow adapter-facing surface: `submitMessage`,
 * `interrupt`, `resetAbortController`, `getModel`, and
 * `setPermissionResolver`. The permission resolver is wired by the adapter
 * (Task 3) to a store-level "ask" flow and upgraded by Task 4 to the real
 * `hasPermissionsToUseTool` pipeline. Until a resolver is registered, the
 * default `canUseTool` DENIES every tool — it never auto-allows, so
 * destructive tools cannot execute without an explicit bridge.
 */

import type { ToolAllowlistEntry } from "@wren/protocol"
import type { AgentDefinition } from "src/tools/AgentTool/loadAgentsDir.js"
import { getAgentDefinitionsWithOverrides } from "src/tools/AgentTool/loadAgentsDir.js"
import { getSessionId, switchSession } from "../bootstrap/state.js"
import type { Command } from "../commands.js"
import { getCommands } from "../commands.js"
import type {
  PermissionResult,
  SDKMessage,
  SDKStatus,
} from "../entrypoints/sdk/coreTypes.generated.js"
import type { CanUseToolFn } from "../hooks/useCanUseTool.js"
import type { QueryEngineConfig } from "../QueryEngine.js"
import { QueryEngine } from "../QueryEngine.js"
import { clearGoal, getGoal } from "../services/goal/goalState.js"
import { buildGoalContextBlock } from "../services/goal/prompts.js"
import { initializeLspServerManager, shutdownLspServerManager } from "../services/lsp/manager.js"
import type { ServerResource } from "../services/mcp/types.js"
import {
  emptyWorkspaceMcpSnapshot,
  type WorkspaceMcpSnapshot,
} from "../services/mcp/workspace-host.js"
import { getDefaultAppState } from "../state/AppStateStore.js"
import type {
  CompactProgressEvent,
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from "../Tool.js"
import { getEmptyToolPermissionContext } from "../Tool.js"
import { filterToolsByDenyRules, getAllBaseTools, WREN_DEFAULT_TOOLS } from "../tools/index.js"
import type { Message } from "../types/message.js"
import type { PermissionMode } from "../types/permissions.js"
import {
  isAutoModeAllowlistedTool,
  isPlanModeAllowlistedTool,
} from "../utils/permissions/classifierDecision.js"
import {
  isSensitivePlanReadPath,
  isSensitivePlanSearchGlob,
} from "../utils/permissions/filesystem.js"
import {
  checkRuleBasedPermissions,
  hasPermissionsToUseTool,
  toolAlwaysAllowedRule,
} from "../utils/permissions/permissions.js"
import {
  classifyYoloAction,
  formatActionForClassifier,
} from "../utils/permissions/yoloClassifier.js"

export { WREN_DEFAULT_TOOLS } from "../tools/index.js"

import { enableConfigs } from "../utils/config.js"
import { logForDebugging } from "../utils/debug.js"
import type { EffortValue } from "../utils/effort.js"
import { errorMessage, toError } from "../utils/errors.js"
import {
  type FileHistoryRestoreFile,
  type FileHistoryRestoreResult,
  type FileHistoryState,
  fileHistoryRestoreSelective,
} from "../utils/fileHistory.js"
import { FileStateCache } from "../utils/fileStateCache.js"
import { logError } from "../utils/log.js"
import { applySafeConfigEnvironmentVariables } from "../utils/managedEnv.js"
import { applyModelConfigToEnv, getModelFallbacks } from "../utils/model/configBridge.js"
import { getMainLoopModel } from "../utils/model/model.js"
import { getAgentTranscript } from "../utils/sessionStorage.js"
import { isTeammate } from "../utils/teammate.js"
import type { EngineHistorySnapshot } from "./history-snapshot.js"

// ---------------------------------------------------------------------------
// Public adapter-facing surface
// ---------------------------------------------------------------------------

export type PermissionModeChangeSource = "manual" | "automatic"

export type PermissionModeChangeOptions = {
  readonly source?: PermissionModeChangeSource
}

export type PermissionResolverContext = {
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly forcePrompt?: boolean
  /**
   * Effective toolPermissionContext.mode at the call site. For subagents this
   * is the agent's resolved mode (see runAgent's agentGetAppState), which can
   * differ from the session's permissionMode. The resolver should prefer this
   * over session.permissionMode when deciding auto-allow behavior.
   */
  readonly mode?: PermissionMode
}

/**
 * Resolves a tool-permission ask. The adapter registers one to bridge
 * `canUseTool` into the Solid store (Task 3 store-level ask; Task 4 upgrades
 * to the real `hasPermissionsToUseTool` pipeline + classifier).
 *
 * `toolName` and `input` come straight from the QueryEngine's
 * `canUseTool(tool, input, ...)` invocation. The resolver returns the
 * {@link PermissionResult} the engine should honor.
 *
 * `context` carries flags from the toolUseContext that the resolver needs to
 * make decisions without direct access to AppState (e.g.
 * shouldAvoidPermissionPrompts for background agents).
 */
export type PermissionResolver = (
  toolName: string,
  input: unknown,
  context?: PermissionResolverContext,
) => Promise<PermissionResult>

export interface WrenEngine {
  submitMessage(
    prompt: string,
    options?: { isMeta?: boolean; uuid?: string },
  ): AsyncGenerator<SDKMessage, void, unknown>
  interrupt(): void
  resetAbortController(): void
  requestYield?(): void
  resetYieldRequest?(): void
  getModel(): string
  setModel(model: string): void
  getEffort?(): string | undefined
  setEffort?(effort: string | undefined): void
  setPermissionResolver(resolver: PermissionResolver | null): void
  setSDKStatusCallback?(callback: ((status: SDKStatus) => void) | null): void
  setOnCompactProgress?(callback: ((event: CompactProgressEvent) => void) | null): void
  /** Sync permission mode from adapter → engine's toolPermissionContext.mode */
  setPermissionMode?(mode: string, options?: PermissionModeChangeOptions): void
  /** Engine notifies adapter when toolPermissionContext.mode changes internally (e.g. EnterPlanMode/ExitPlanMode tools) */
  setPermissionModeChangeCallback?(callback: ((mode: string) => void) | null): void
  getMessages(): readonly unknown[]
  truncateMessages(count: number): void
  snapshotHistory(): EngineHistorySnapshot
  restoreHistory(snapshot: EngineHistorySnapshot): void
  getFileHistoryState?(): FileHistoryState
  restoreFileHistory?(
    messageId: string,
    files: readonly FileHistoryRestoreFile[],
  ): Promise<FileHistoryRestoreResult>
  dispose(): void
}

export type McpSnapshotProvider = () => WorkspaceMcpSnapshot | Promise<WorkspaceMcpSnapshot>

export type CreateWrenEngineOptions = {
  readonly canUseTool?: CanUseToolFn
  readonly cwd?: string
  readonly model?: string
  readonly effort?: string
  readonly initialMessages?: readonly unknown[]
  readonly mcpSnapshotProvider?: McpSnapshotProvider
}

export type WrenEngineFactory = {
  createEngine(
    sessionId: string,
    options?: {
      readonly initialMessages?: readonly unknown[]
      readonly model?: string
      readonly effort?: string
    },
  ): Promise<WrenEngine>
  getDefaultModel(): string
  getCommands(): readonly Command[]
  getAgents(): readonly AgentDefinition[]
  getAgentTranscript(agentId: string, sessionId?: string): Promise<{ messages: unknown[] } | null>
  getEngineSessionId(): string
  dispose(): void
}

// ---------------------------------------------------------------------------
// Internal canUseTool wrapper
// ---------------------------------------------------------------------------

type ToolLike = Tool | undefined

type ToolUseContextLike = {
  readonly getAppState?: ToolUseContext["getAppState"]
  readonly options?: ToolUseContext["options"]
}

type InternalCanUseTool = (
  tool: ToolLike,
  input: unknown,
  toolUseContext?: ToolUseContextLike,
) => Promise<PermissionResult>

type PermissionCheck = (
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
) => Promise<PermissionResult>

const runEnginePermissionCheck = hasPermissionsToUseTool as unknown as PermissionCheck

function isToolUseContext(value: ToolUseContextLike | undefined): value is ToolUseContext {
  return (
    value !== undefined && typeof value.getAppState === "function" && value.options !== undefined
  )
}

function planPermissionContext(context: ToolUseContext): ToolUseContext {
  const appState = context.getAppState()
  return {
    ...context,
    getAppState: () => ({
      ...appState,
      toolPermissionContext: {
        ...appState.toolPermissionContext,
        mode: "default",
        isFullModeAvailable: false,
      },
    }),
  }
}

function isPlanSafeAgent(
  input: { [key: string]: unknown },
  agents: readonly AgentDefinition[],
): boolean {
  const agentType = input.subagent_type
  if (agentType !== "Explore" && agentType !== "Plan") return false
  const definition = agents.find((agent) => agent.agentType === agentType)
  return definition?.source === "built-in"
}

export function isPlanSafeToolInput(tool: Tool, input: { [key: string]: unknown }): boolean {
  if (!isPlanModeAllowlistedTool(tool.name)) return false
  if (tool.name === "Read") {
    return typeof input.file_path === "string" && !isSensitivePlanReadPath(input.file_path)
  }
  if (tool.name === "LSP") {
    return typeof input.filePath === "string" && !isSensitivePlanReadPath(input.filePath)
  }
  if (tool.name === "Glob") {
    const pathIsSafe = typeof input.path !== "string" || !isSensitivePlanReadPath(input.path)
    return (
      pathIsSafe && typeof input.pattern === "string" && !isSensitivePlanSearchGlob(input.pattern)
    )
  }
  if (tool.name === "Grep") {
    const pathIsSafe = typeof input.path !== "string" || !isSensitivePlanReadPath(input.path)
    const globIsSafe = typeof input.glob !== "string" || !isSensitivePlanSearchGlob(input.glob)
    return pathIsSafe && globIsSafe
  }
  return true
}

export type PermissionPromptOptions = {
  readonly onForcePrompt?: () => void
}

export async function checkEnterPlanPermission(
  tool: Tool,
  input: unknown,
  toolUseContext: ToolUseContext,
  options?: PermissionPromptOptions,
): Promise<PermissionResult | null> {
  if (tool.name !== "EnterPlanMode") return null

  let parsedInput: { [key: string]: unknown }
  try {
    parsedInput = tool.inputSchema.parse(input) as { [key: string]: unknown }
  } catch {
    return null
  }

  const ruleResult = await checkRuleBasedPermissions(tool, parsedInput, toolUseContext)
  if (ruleResult?.behavior === "deny") return ruleResult
  if (ruleResult !== null) {
    options?.onForcePrompt?.()
    return null
  }

  const result = await runEnginePermissionCheck(tool, parsedInput, toolUseContext)
  return result.behavior === "allow" ? result : null
}

export async function checkPlanPermission(
  tool: Tool,
  input: unknown,
  toolUseContext: ToolUseContext,
  messages: readonly unknown[],
  tools: Tools,
  agents: readonly AgentDefinition[],
  options?: PermissionPromptOptions,
): Promise<PermissionResult | null> {
  const isExitPlanMode = tool.name === "ExitPlanMode"
  if (
    toolUseContext.getAppState().toolPermissionContext.mode !== "plan" &&
    !(isExitPlanMode && isTeammate())
  ) {
    return null
  }

  let parsedInput: { [key: string]: unknown }
  try {
    parsedInput = tool.inputSchema.parse(input) as { [key: string]: unknown }
  } catch {
    return null
  }

  const isSafeAgent = tool.name === "Agent" && isPlanSafeAgent(parsedInput, agents)

  const ruleResult = await checkRuleBasedPermissions(tool, parsedInput, toolUseContext)
  if (ruleResult?.behavior === "deny") return ruleResult
  if (ruleResult !== null) {
    options?.onForcePrompt?.()
    return null
  }

  if (
    tool.requiresUserInteraction?.() ||
    tool.isMcp === true ||
    (tool.name === "Agent" && !isSafeAgent) ||
    tool.name === "WebFetch" ||
    tool.name === "WebSearch" ||
    (!isExitPlanMode && !tool.isReadOnly(parsedInput))
  ) {
    return null
  }

  const planResult = await runEnginePermissionCheck(
    tool,
    parsedInput,
    planPermissionContext(toolUseContext),
  )
  if (planResult.behavior !== "allow") return null

  // These tools have already passed their own rule and workspace checks. Avoid
  // a model-based audit for basic local exploration; a classifier failure would
  // otherwise turn every Read/Grep/Glob call into an interactive permission.
  if (isExitPlanMode || isSafeAgent || isPlanSafeToolInput(tool, parsedInput)) return planResult
  if (isPlanModeAllowlistedTool(tool.name)) return null

  const auditResult = await classifyYoloAction(
    messages as Message[],
    formatActionForClassifier(tool.name, parsedInput),
    tools,
    toolUseContext.getAppState().toolPermissionContext,
    toolUseContext.abortController.signal,
    "plan",
  )
  if (auditResult.unavailable || auditResult.transcriptTooLong) return null
  if (auditResult.shouldBlock) return null
  return planResult
}

async function checkAutoPermission(
  tool: Tool,
  input: unknown,
  toolUseContext: ToolUseContext,
  messages: readonly unknown[],
  tools: Tools,
): Promise<PermissionResult | null> {
  if (toolUseContext.getAppState().toolPermissionContext.mode !== "auto") return null

  let parsedInput: { [key: string]: unknown }
  try {
    parsedInput = tool.inputSchema.parse(input) as { [key: string]: unknown }
  } catch {
    return null
  }

  const ruleResult = await checkRuleBasedPermissions(tool, parsedInput, toolUseContext)
  if (ruleResult !== null) {
    if (ruleResult.behavior === "deny") return ruleResult
    if (ruleResult.decisionReason?.type === "rule") return null
    if (
      ruleResult.decisionReason?.type === "safetyCheck" &&
      !ruleResult.decisionReason.classifierApprovable
    ) {
      return null
    }
  }

  if (tool.requiresUserInteraction?.()) return null
  if (isAutoModeAllowlistedTool(tool.name)) return { behavior: "allow" }

  const alwaysAllowedRule = toolAlwaysAllowedRule(
    toolUseContext.getAppState().toolPermissionContext,
    tool,
  )
  if (alwaysAllowedRule) return { behavior: "allow" }

  const result = await classifyYoloAction(
    messages as Message[],
    formatActionForClassifier(tool.name, parsedInput),
    tools,
    toolUseContext.getAppState().toolPermissionContext,
    toolUseContext.abortController.signal,
  )
  if (result.unavailable || result.transcriptTooLong) return null
  if (result.shouldBlock) {
    return {
      behavior: "deny",
      message: `Auto mode blocked: ${result.reason}`,
    }
  }
  return { behavior: "allow" }
}

function denyAllResolver(): PermissionResult {
  return {
    behavior: "deny",
    message: "no permission resolver configured (Task 4 wires the bridge)",
  }
}

export function permissionContextForModeChange(
  context: ToolPermissionContext,
  mode: PermissionMode,
  options?: PermissionModeChangeOptions,
): ToolPermissionContext {
  const current = context.mode
  const source = options?.source ?? "automatic"
  if (mode === current) {
    if (mode !== "plan") return context
    return {
      ...context,
      planExitApprovalRequired: source === "manual",
    }
  }
  if (mode === "plan") {
    return {
      ...context,
      mode,
      prePlanMode: current,
      planExitApprovalRequired: source === "manual",
    }
  }
  return {
    ...context,
    mode,
    prePlanMode: current === "plan" ? undefined : context.prePlanMode,
    planExitApprovalRequired: undefined,
  }
}

// ---------------------------------------------------------------------------
// createWrenEngine
// ---------------------------------------------------------------------------

/**
 * Instantiate the real QueryEngine with real tools and model selection.
 *
 * Async because commands and agents are loaded from disk (via `getCommands`)
 * and MCP snapshots may be provided asynchronously. Configs are enabled and
 * the safe environment is applied so the model provider resolves consistently.
 */
export async function createWrenEngine(options?: CreateWrenEngineOptions): Promise<WrenEngine> {
  enableConfigs()
  applySafeConfigEnvironmentVariables()
  if (process.env.WREN_ENABLE_STREAM_WATCHDOG === undefined) {
    process.env.WREN_ENABLE_STREAM_WATCHDOG = "1"
  }
  // LSP is a process-wide singleton (idempotent). Config loading happens in
  // initConfig() before createWrenEngine is called; servers start lazily on
  // first LSPTool use.
  initializeLspServerManager()

  const cwd = options?.cwd ?? process.cwd()
  let mcpSnapshot: WorkspaceMcpSnapshot
  try {
    mcpSnapshot = options?.mcpSnapshotProvider
      ? await options.mcpSnapshotProvider()
      : emptyWorkspaceMcpSnapshot()
  } catch (error) {
    logError(toError(error))
    logForDebugging(
      `[engine] MCP snapshot load failed; continuing without MCP tools: ${errorMessage(error)}`,
    )
    mcpSnapshot = emptyWorkspaceMcpSnapshot()
  }
  const permissionContext = getEmptyToolPermissionContext()
  const tools = [...resolveRealTools(permissionContext), ...mcpSnapshot.tools]
  let model = options?.model ?? getMainLoopModel()

  // Load slash commands and agent definitions from the project.
  // Both are async (read from disk); failures are non-fatal — the engine
  // runs with empty arrays if loading fails, but the failure must be visible.
  let commands: Command[] = []
  let agents: AgentDefinition[] = []
  try {
    commands = await getCommands(cwd)
  } catch (error) {
    logError(toError(error))
    logForDebugging(
      `[engine] Slash command loading failed; running without commands: ${errorMessage(error)}`,
    )
  }
  try {
    const agentResult = await getAgentDefinitionsWithOverrides(cwd)
    agents = agentResult.activeAgents
  } catch (error) {
    logError(toError(error))
    logForDebugging(
      `[engine] Agent definition loading failed; running without custom agents: ${errorMessage(error)}`,
    )
  }

  // AppState is mutated by the QueryEngine via setAppState. Shallow-copy the
  // default and mutate in place (same pattern as createSessionMethod).
  // setAppState's `updater` param is intentionally unannotated: the vendored
  // AppState stub is `unknown`, so annotating with the real AppState type
  // would force a contravariance error.
  const appState = {
    ...getDefaultAppState(),
    effortValue: options?.effort as EffortValue | undefined,
    toolPermissionContext: {
      ...permissionContext,
      mode: "default" as PermissionMode,
    },
  }

  const readFileCache = new FileStateCache(500, 50 * 1024 * 1024)

  let resolver: PermissionResolver | null = null
  let modeChangeCallback: ((mode: string) => void) | null = null
  let syncingFromAdapter = false

  const internalCanUseTool: InternalCanUseTool = async (tool, input, toolUseContext) => {
    if (resolver !== null) {
      const promptState = { forcePrompt: false }
      const promptOptions: PermissionPromptOptions = {
        onForcePrompt: () => {
          promptState.forcePrompt = true
        },
      }
      if (tool !== undefined && isToolUseContext(toolUseContext)) {
        const enterPlanResult = await checkEnterPlanPermission(
          tool,
          input,
          toolUseContext,
          promptOptions,
        )
        if (enterPlanResult !== null) return enterPlanResult
        const planResult = await checkPlanPermission(
          tool,
          input,
          toolUseContext,
          engine.getMessages(),
          tools,
          agents,
          promptOptions,
        )
        if (planResult !== null) return planResult
        const autoResult = await checkAutoPermission(
          tool,
          input,
          toolUseContext,
          engine.getMessages(),
          tools,
        )
        if (autoResult !== null) return autoResult

        // Subagents launched from a plan-mode parent run with their own
        // resolved mode (runAgent's agentGetAppState), so the plan guard above
        // sees a non-plan mode and skips. Re-evaluate with the parent's plan
        // view: plan-safe workspace reads keep their auto-allow, while
        // sensitive reads and everything else fall through to the resolver,
        // which decides using the subagent's effective mode.
        const sessionMode = appState.toolPermissionContext.mode
        const contextMode = toolUseContext.getAppState().toolPermissionContext.mode
        if (sessionMode === "plan" && contextMode !== "plan") {
          const planViewContext: ToolUseContext = {
            ...toolUseContext,
            getAppState: () => {
              const subagentState = toolUseContext.getAppState()
              return {
                ...subagentState,
                toolPermissionContext: {
                  ...subagentState.toolPermissionContext,
                  mode: sessionMode,
                },
              }
            },
          }
          const planViewResult = await checkPlanPermission(
            tool,
            input,
            planViewContext,
            engine.getMessages(),
            tools,
            agents,
            promptOptions,
          )
          if (planViewResult !== null) return planViewResult
        }
      }
      const toolName = tool?.name ?? "unknown"
      const shouldAvoid =
        toolUseContext?.getAppState?.()?.toolPermissionContext?.shouldAvoidPermissionPrompts
      const effectiveMode =
        isToolUseContext(toolUseContext) && tool !== undefined
          ? toolUseContext.getAppState().toolPermissionContext.mode
          : undefined
      const resolverContext = {
        ...(shouldAvoid !== undefined && { shouldAvoidPermissionPrompts: shouldAvoid }),
        ...(promptState.forcePrompt && { forcePrompt: true }),
        ...(effectiveMode !== undefined && { mode: effectiveMode }),
      }
      return resolver(
        toolName,
        input,
        Object.keys(resolverContext).length > 0 ? resolverContext : undefined,
      )
    }
    return denyAllResolver()
  }

  // If the caller supplied an explicit canUseTool (e.g. test auto-allow),
  // it owns permission decisions; the resolver path is bypassed. CanUseToolFn
  // is stubbed to `unknown`, so no cast is needed.
  const canUseTool: unknown = options?.canUseTool ?? internalCanUseTool

  const engineConfig: QueryEngineConfig = {
    cwd,
    tools,
    commands: [...commands, ...mcpSnapshot.commands],
    mcpClients: [...mcpSnapshot.clients],
    mcpResources: groupMcpResources(mcpSnapshot.resources),
    agents,
    canUseTool: canUseTool as any,
    getAppState: () => appState,
    setAppState: (updater) => {
      const prevMode = appState.toolPermissionContext?.mode
      Object.assign(appState, updater(appState))
      const newMode = appState.toolPermissionContext?.mode
      if (prevMode !== newMode && newMode !== undefined && !syncingFromAdapter) {
        modeChangeCallback?.(newMode)
      }
    },
    readFileCache,
    includePartialMessages: true,
    ...(options?.initialMessages !== undefined && {
      initialMessages: options.initialMessages as QueryEngineConfig["initialMessages"],
    }),
  }

  const engine = new QueryEngine(engineConfig)
  engine.setModel(model)

  return {
    submitMessage(
      prompt: string,
      options?: { isMeta?: boolean; uuid?: string },
    ): AsyncGenerator<SDKMessage, void, unknown> {
      return engine.submitMessage(prompt, options)
    },
    interrupt(): void {
      engine.interrupt()
    },
    resetAbortController(): void {
      engine.resetAbortController()
    },
    getModel(): string {
      return model
    },
    setModel(next: string): void {
      model = next
      engine.setModel(next)
    },
    getEffort(): string | undefined {
      const value = appState.effortValue
      return typeof value === "number" ? String(value) : value
    },
    setEffort(effort: string | undefined): void {
      appState.effortValue = effort as EffortValue | undefined
    },
    setPermissionResolver(next: PermissionResolver | null): void {
      if (options?.canUseTool !== undefined) return
      resolver = next
    },
    setPermissionMode(mode: string, options?: PermissionModeChangeOptions): void {
      syncingFromAdapter = true
      appState.toolPermissionContext = permissionContextForModeChange(
        appState.toolPermissionContext,
        mode as PermissionMode,
        options,
      )
      syncingFromAdapter = false
    },
    setPermissionModeChangeCallback(callback: ((mode: string) => void) | null): void {
      modeChangeCallback = callback
    },
    getMessages(): readonly unknown[] {
      return engine.getMessages()
    },
    truncateMessages(count: number): void {
      engine.truncateMessages(count)
    },
    snapshotHistory(): EngineHistorySnapshot {
      return engine.snapshotHistory()
    },
    restoreHistory(snapshot: EngineHistorySnapshot): void {
      engine.restoreHistory(snapshot)
    },
    getFileHistoryState(): FileHistoryState {
      return appState.fileHistory
    },
    restoreFileHistory(
      messageId: string,
      files: readonly FileHistoryRestoreFile[],
    ): Promise<FileHistoryRestoreResult> {
      return fileHistoryRestoreSelective(appState.fileHistory, messageId, files)
    },
    dispose(): void {
      engine.interrupt()
      engine.resetAbortController()
      readFileCache.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// createWrenEngineFactory — loads shared metadata once, creates engines per session
// ---------------------------------------------------------------------------

export async function createWrenEngineFactory(
  options?: CreateWrenEngineOptions,
): Promise<WrenEngineFactory> {
  enableConfigs()
  applySafeConfigEnvironmentVariables()
  if (process.env.WREN_ENABLE_STREAM_WATCHDOG === undefined) {
    process.env.WREN_ENABLE_STREAM_WATCHDOG = "1"
  }
  // LSP is a process-wide singleton (idempotent). Config loading happens in
  // initConfig() before createWrenEngineFactory is called; servers start
  // lazily on first LSPTool use.
  initializeLspServerManager()

  const cwd = options?.cwd ?? process.cwd()
  const permissionContext = getEmptyToolPermissionContext()
  const tools = resolveRealTools(permissionContext)
  const defaultModel = options?.model ?? getMainLoopModel()

  let commands: Command[] = []
  let agents: AgentDefinition[] = []
  try {
    commands = await getCommands(cwd)
  } catch {
    // empty — run without slash commands
  }
  try {
    const agentResult = await getAgentDefinitionsWithOverrides(cwd)
    agents = agentResult.activeAgents
  } catch {
    // empty — run without custom agents
  }

  const engines = new Map<string, WrenEngine>()

  async function createEngine(
    sessionId: string,
    sessionOptions?: {
      readonly initialMessages?: readonly unknown[]
      readonly model?: string
      readonly effort?: string
    },
  ): Promise<WrenEngine> {
    const existing = engines.get(sessionId)
    if (existing !== undefined) return existing

    switchSession(sessionId as never)
    const appState = {
      ...getDefaultAppState(),
      effortValue: sessionOptions?.effort as EffortValue | undefined,
      toolPermissionContext: { ...permissionContext, mode: "default" as PermissionMode },
    }
    const readFileCache = new FileStateCache(500, 50 * 1024 * 1024)
    let resolver: PermissionResolver | null = null
    let sdkStatusCallback: ((status: SDKStatus) => void) | null = null
    let onCompactProgressCallback: ((event: CompactProgressEvent) => void) | null = null
    let modeChangeCallback: ((mode: string) => void) | null = null
    let syncingFromAdapter = false

    const internalCanUseTool: InternalCanUseTool = async (tool, input, toolUseContext) => {
      if (resolver !== null) {
        const promptState = { forcePrompt: false }
        const promptOptions: PermissionPromptOptions = {
          onForcePrompt: () => {
            promptState.forcePrompt = true
          },
        }
        if (tool !== undefined && isToolUseContext(toolUseContext)) {
          const enterPlanResult = await checkEnterPlanPermission(
            tool,
            input,
            toolUseContext,
            promptOptions,
          )
          if (enterPlanResult !== null) return enterPlanResult
          const planResult = await checkPlanPermission(
            tool,
            input,
            toolUseContext,
            engine.getMessages(),
            sessionTools,
            agents,
            promptOptions,
          )
          if (planResult !== null) return planResult
          const autoResult = await checkAutoPermission(
            tool,
            input,
            toolUseContext,
            engine.getMessages(),
            sessionTools,
          )
          if (autoResult !== null) return autoResult

          // Subagents launched from a plan-mode parent run with their own
          // resolved mode (runAgent's agentGetAppState), so the plan guard
          // above sees a non-plan mode and skips. Re-evaluate with the
          // parent's plan view: plan-safe workspace reads keep their
          // auto-allow, while sensitive reads and everything else fall
          // through to the resolver, which decides using the subagent's
          // effective mode.
          const sessionMode = appState.toolPermissionContext.mode
          const contextMode = toolUseContext.getAppState().toolPermissionContext.mode
          if (sessionMode === "plan" && contextMode !== "plan") {
            const planViewContext: ToolUseContext = {
              ...toolUseContext,
              getAppState: () => {
                const subagentState = toolUseContext.getAppState()
                return {
                  ...subagentState,
                  toolPermissionContext: {
                    ...subagentState.toolPermissionContext,
                    mode: sessionMode,
                  },
                }
              },
            }
            const planViewResult = await checkPlanPermission(
              tool,
              input,
              planViewContext,
              engine.getMessages(),
              sessionTools,
              agents,
              promptOptions,
            )
            if (planViewResult !== null) return planViewResult
          }
        }
        const toolName = tool?.name ?? "unknown"
        const shouldAvoid =
          toolUseContext?.getAppState?.()?.toolPermissionContext?.shouldAvoidPermissionPrompts
        const effectiveMode =
          isToolUseContext(toolUseContext) && tool !== undefined
            ? toolUseContext.getAppState().toolPermissionContext.mode
            : undefined
        const resolverContext = {
          ...(shouldAvoid !== undefined && { shouldAvoidPermissionPrompts: shouldAvoid }),
          ...(promptState.forcePrompt && { forcePrompt: true }),
          ...(effectiveMode !== undefined && { mode: effectiveMode }),
        }
        return resolver(
          toolName,
          input,
          Object.keys(resolverContext).length > 0 ? resolverContext : undefined,
        )
      }
      return denyAllResolver()
    }

    const canUseTool: unknown = options?.canUseTool ?? internalCanUseTool
    let model = sessionOptions?.model ?? defaultModel
    let mcpSnapshot: WorkspaceMcpSnapshot
    try {
      mcpSnapshot = options?.mcpSnapshotProvider
        ? await options.mcpSnapshotProvider()
        : emptyWorkspaceMcpSnapshot()
    } catch (error) {
      logError(toError(error))
      logForDebugging(
        `[engine] MCP snapshot load failed; continuing without MCP tools: ${errorMessage(error)}`,
      )
      mcpSnapshot = emptyWorkspaceMcpSnapshot()
    }
    const sessionTools = [...tools, ...mcpSnapshot.tools]
    const sessionCommands = [...commands, ...mcpSnapshot.commands]

    const fallbackModels = getModelFallbacks(model)
    const engineConfig: QueryEngineConfig = {
      cwd,
      tools: sessionTools,
      commands: sessionCommands,
      mcpClients: [...mcpSnapshot.clients],
      mcpResources: groupMcpResources(mcpSnapshot.resources),
      agents,
      canUseTool: canUseTool as any,
      getAppState: () => appState,
      setAppState: (updater) => {
        const prevMode = appState.toolPermissionContext?.mode
        Object.assign(appState, updater(appState))
        const newMode = appState.toolPermissionContext?.mode
        if (prevMode !== newMode && newMode !== undefined && !syncingFromAdapter) {
          modeChangeCallback?.(newMode)
        }
      },
      readFileCache,
      includePartialMessages: true,
      sessionStorageContext: { sessionId, projectPath: cwd },
      ...(fallbackModels.length > 0 && { fallbackModel: fallbackModels[0] }),
      setSDKStatus: (status: SDKStatus) => {
        sdkStatusCallback?.(status)
      },
      onCompactProgress: (event: CompactProgressEvent) => {
        onCompactProgressCallback?.(event)
      },
      ...(sessionOptions?.initialMessages !== undefined && {
        initialMessages: sessionOptions.initialMessages as QueryEngineConfig["initialMessages"],
      }),
      getGoalContext: () => {
        const goal = getGoal(sessionId)
        return goal?.status === "active" ? buildGoalContextBlock(goal) : undefined
      },
      isYieldRequested: () => engine.isYieldRequested(),
    }

    const engine = new QueryEngine(engineConfig)
    engine.setModel(model)

    const wrenEngine: WrenEngine = {
      submitMessage(prompt: string, options?: { isMeta?: boolean; uuid?: string }) {
        switchSession(sessionId as never)
        return engine.submitMessage(prompt, options)
      },
      interrupt() {
        engine.interrupt()
      },
      resetAbortController() {
        engine.resetAbortController()
      },
      requestYield() {
        engine.requestYield()
      },
      resetYieldRequest() {
        engine.resetYieldRequest()
      },
      getModel() {
        return model
      },
      setModel(next: string) {
        model = next
        applyModelConfigToEnv(next)
        engine.setModel(next)
      },
      getEffort(): string | undefined {
        const value = appState.effortValue
        return typeof value === "number" ? String(value) : value
      },
      setEffort(effort: string | undefined) {
        appState.effortValue = effort as EffortValue | undefined
      },
      setPermissionResolver(next: PermissionResolver | null) {
        if (options?.canUseTool !== undefined) return
        resolver = next
      },
      setPermissionMode(mode: string, options?: PermissionModeChangeOptions) {
        syncingFromAdapter = true
        appState.toolPermissionContext = permissionContextForModeChange(
          appState.toolPermissionContext,
          mode as PermissionMode,
          options,
        )
        syncingFromAdapter = false
      },
      setPermissionModeChangeCallback(callback: ((mode: string) => void) | null) {
        modeChangeCallback = callback
      },
      setSDKStatusCallback(callback: ((status: SDKStatus) => void) | null) {
        sdkStatusCallback = callback
      },
      setOnCompactProgress(callback: ((event: CompactProgressEvent) => void) | null) {
        onCompactProgressCallback = callback
      },
      getMessages() {
        return engine.getMessages()
      },
      truncateMessages(count: number) {
        engine.truncateMessages(count)
      },
      snapshotHistory() {
        return engine.snapshotHistory()
      },
      restoreHistory(snapshot: EngineHistorySnapshot) {
        engine.restoreHistory(snapshot)
      },
      getFileHistoryState(): FileHistoryState {
        return appState.fileHistory
      },
      restoreFileHistory(
        messageId: string,
        files: readonly FileHistoryRestoreFile[],
      ): Promise<FileHistoryRestoreResult> {
        return fileHistoryRestoreSelective(appState.fileHistory, messageId, files)
      },
      dispose() {
        engine.interrupt()
        engine.resetAbortController()
        readFileCache.clear()
        clearGoal(sessionId)
        engines.delete(sessionId)
      },
    }
    engines.set(sessionId, wrenEngine)
    return wrenEngine
  }

  return {
    createEngine,
    getDefaultModel() {
      return defaultModel
    },
    getCommands() {
      return commands
    },
    getAgents() {
      return agents
    },
    async getAgentTranscript(agentId: string, sessionId?: string) {
      // Read-only transcript access — do NOT call switchSession() to avoid
      // side effects (PID file updates, durable command restore, plan cache).
      // If a different session is needed, save/restore the current session.
      if (sessionId !== undefined && sessionId !== getSessionId()) {
        const savedSession = getSessionId()
        switchSession(sessionId as never)
        try {
          const result = await getAgentTranscript(agentId as never)
          if (result === null) return null
          return { messages: result.messages }
        } finally {
          switchSession(savedSession as never)
        }
      }
      const result = await getAgentTranscript(agentId as never)
      if (result === null) return null
      return { messages: result.messages }
    },
    getEngineSessionId() {
      return getSessionId()
    },
    dispose() {
      for (const wrenEngine of engines.values()) {
        wrenEngine.dispose()
      }
      engines.clear()
      // LSP servers are process-wide child processes; release them so they
      // don't outlive the session (idempotent — safe on repeated dispose).
      void shutdownLspServerManager()
    },
  }
}

function groupMcpResources(resources: readonly ServerResource[]): Record<string, ServerResource[]> {
  const grouped: Record<string, ServerResource[]> = {}
  for (const resource of resources) {
    const bucket = grouped[resource.server]
    if (bucket === undefined) grouped[resource.server] = [resource]
    else bucket.push(resource)
  }
  return grouped
}

// ---------------------------------------------------------------------------
// Deny-by-default tool allowlist
// ---------------------------------------------------------------------------

export const WREN_TOOL_CLASSIFICATIONS: readonly ToolAllowlistEntry[] = [
  { toolName: "Read", decision: "allow", reason: "Core file reading capability" },
  { toolName: "Edit", decision: "allow", reason: "Core file editing capability" },
  { toolName: "Write", decision: "allow", reason: "Core file writing capability" },
  { toolName: "Glob", decision: "allow", reason: "Core file pattern matching" },
  { toolName: "Grep", decision: "allow", reason: "Core content search" },
  { toolName: "TodoWrite", decision: "allow", reason: "Core task tracking" },
  { toolName: "AskUserQuestion", decision: "allow", reason: "User interaction" },
  { toolName: "Bash", decision: "allow", reason: "Shell command execution with permission proof" },
  {
    toolName: "Agent",
    decision: "allow",
    reason: "Subagent system — InProcessTeammateTask drives child agent sessions",
  },
  {
    toolName: "TaskOutput",
    decision: "allow",
    reason: "Read subagent output — paired with Agent tool",
  },
  { toolName: "TaskStop", decision: "allow", reason: "Stop subagent — paired with Agent tool" },
  { toolName: "ExitPlanMode", decision: "allow", reason: "Plan mode — core interaction feature" },
  { toolName: "EnterPlanMode", decision: "allow", reason: "Plan mode — core interaction feature" },
  {
    toolName: "NotebookEdit",
    decision: "allow",
    reason: "Notebook editing — same category as Edit/Write",
  },
  { toolName: "Artifact", decision: "isolate", reason: "Remote artifact storage not supported" },
  { toolName: "artifact", decision: "isolate", reason: "Artifact tool variant — not supported" },
  {
    toolName: "WebFetch",
    decision: "allow",
    reason: "Web fetching — controlled via permission modal",
  },
  {
    toolName: "WebSearch",
    decision: "allow",
    reason:
      "Web search — default uses Anthropic server-side web_search_20250305; Brave/Bing/Exa via env",
  },
  { toolName: "Skill", decision: "allow", reason: "Skill system — reads .wren/skills/ directory" },
  { toolName: "LocalMemoryRecall", decision: "allow", reason: "Memory recall — local memory read" },
  {
    toolName: "LSP",
    decision: "allow",
    reason:
      "Code intelligence — upstream core tool, provides go-to-definition, references, diagnostics",
  },
  {
    toolName: "VaultHttpFetch",
    decision: "defer",
    reason: "Vault-secret HTTP fetch — non-default",
  },
  {
    toolName: "GoalTool",
    decision: "allow",
    reason: "Goal tool — persistent thread objective tracking",
  },
  { toolName: "SendMessage", decision: "defer", reason: "Agent-team messaging — non-default" },
  {
    toolName: "SendUserMessage",
    decision: "defer",
    reason: "User messaging (BriefTool) — non-default",
  },
  { toolName: "TeamCreate", decision: "defer", reason: "Agent teams — non-default" },
  { toolName: "TeamDelete", decision: "defer", reason: "Agent teams — non-default" },
  { toolName: "ListPeers", decision: "remove", reason: "P2P not supported" },
  {
    toolName: "VerifyPlanExecution",
    decision: "allow",
    reason: "Plan verification — upstream core tool, gates plan mode completion",
  },
  { toolName: "Brief", decision: "remove", reason: "Brief tool not available at pinned version" },
  { toolName: "CronCreate", decision: "defer", reason: "Cron scheduling — non-default" },
  { toolName: "CronDelete", decision: "defer", reason: "Cron scheduling — non-default" },
  { toolName: "CronList", decision: "defer", reason: "Cron scheduling — non-default" },
  { toolName: "RemoteTrigger", decision: "remove", reason: "Remote triggers not supported" },
  { toolName: "Monitor", decision: "remove", reason: "Monitoring not supported" },
  { toolName: "PushNotification", decision: "remove", reason: "Push notifications not supported" },
  { toolName: "SendUserFile", decision: "remove", reason: "File sending not supported" },
  { toolName: "SubscribePR", decision: "remove", reason: "PR subscription not supported" },
  { toolName: "ReviewArtifact", decision: "remove", reason: "Artifact review not supported" },
  { toolName: "Snip", decision: "defer", reason: "Snip tool requires HISTORY_SNIP feature flag" },
  {
    toolName: "DiscoverSkills",
    decision: "defer",
    reason: "Skill discovery — depends on skill system maturity",
  },
  {
    toolName: "ListMcpResources",
    decision: "defer",
    reason: "MCP requires configuration infrastructure",
  },
  {
    toolName: "ListMcpResourcesTool",
    decision: "defer",
    reason: "MCP requires configuration infrastructure",
  },
  {
    toolName: "ReadMcpResource",
    decision: "defer",
    reason: "MCP requires configuration infrastructure",
  },
  {
    toolName: "ReadMcpResourceTool",
    decision: "defer",
    reason: "MCP requires configuration infrastructure",
  },
  {
    toolName: "SearchExtraTools",
    decision: "allow",
    reason: "Deferred tool discovery — upstream core tool, enables on-demand tool loading",
  },
  {
    toolName: "Execute",
    decision: "remove",
    reason: "Alias for ExecuteExtraTool — see that entry",
  },
  {
    toolName: "ExecuteExtraTool",
    decision: "allow",
    reason: "Deferred tool execution — upstream core tool, executes discovered tools",
  },
  { toolName: "Sleep", decision: "remove", reason: "Sleep tool not available at pinned version" },
  { toolName: "TerminalCapture", decision: "isolate", reason: "Terminal capture not supported" },
  { toolName: "EnterWorktree", decision: "defer", reason: "Worktree mode — non-core feature" },
  { toolName: "ExitWorktree", decision: "defer", reason: "Worktree mode — non-core feature" },
  { toolName: "REPL", decision: "defer", reason: "REPL — needs additional runtime" },
  { toolName: "Workflow", decision: "remove", reason: "Workflow engine not supported" },
  {
    toolName: "CtxInspect",
    decision: "remove",
    reason: "CtxInspect tool not available at pinned version",
  },
  {
    toolName: "PowerShell",
    decision: "defer",
    reason: "PowerShell — Windows only, not applicable",
  },
  { toolName: "WebBrowser", decision: "isolate", reason: "Browser automation not supported" },
  { toolName: "SuggestBackgroundPR", decision: "remove", reason: "PR suggestions not supported" },
  {
    toolName: "Config",
    decision: "defer",
    reason: "Config tool — needs configuration infrastructure",
  },
  {
    toolName: "TaskCreate",
    decision: "defer",
    reason: "Task v2 — designed for multi-agent teams; Wren uses TodoWrite instead",
  },
  {
    toolName: "TaskGet",
    decision: "defer",
    reason: "Task v2 — designed for multi-agent teams; Wren uses TodoWrite instead",
  },
  {
    toolName: "TaskUpdate",
    decision: "defer",
    reason: "Task v2 — designed for multi-agent teams; Wren uses TodoWrite instead",
  },
  {
    toolName: "TaskList",
    decision: "defer",
    reason: "Task v2 — designed for multi-agent teams; Wren uses TodoWrite instead",
  },
  { toolName: "OverflowTest", decision: "remove", reason: "Test-only tool" },
]

const ALLOWED_TOOL_NAMES = new Set(WREN_DEFAULT_TOOLS)

function isToolAllowed(toolName: string): boolean {
  return ALLOWED_TOOL_NAMES.has(toolName)
}

/** Deny-by-default: only tools in {@link WREN_DEFAULT_TOOLS} are registered. */
function resolveRealTools(
  permissionContext: ReturnType<typeof getEmptyToolPermissionContext>,
): Tools {
  const all = getAllBaseTools()
  const allowed = all.filter((tool: Tool) => {
    const name = tool.name
    if (!isToolAllowed(name)) return false
    const candidate = tool as unknown as { isEnabled?: unknown }
    return typeof candidate.isEnabled === "function"
  })
  const denyFiltered = filterToolsByDenyRules(allowed, permissionContext)
  return denyFiltered.filter((tool) => {
    const candidate = tool as unknown as { isEnabled: () => boolean }
    return candidate.isEnabled()
  })
}

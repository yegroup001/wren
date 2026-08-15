import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { WrenApplication } from "@wren/application"
import { getWrenConfigHome, loadModelRegistry } from "@wren/config-node"
import type {
  CompactProgressEvent,
  EngineHistorySnapshot,
  GoalState,
  PermissionResolver,
  PermissionResolverContext,
  WrenEngine,
  WrenEngineFactory,
} from "@wren/engine"
import { hydrateGoalFromState, isSafeAgentId } from "@wren/engine"

import {
  type Diff,
  type Message,
  type Part,
  type PermissionRequest,
  parseMessageId,
  parsePartId,
  parsePermissionId,
  parseRequestId,
  parseSessionId,
  type QuestionRequest,
  type SelectedModelReference,
  type Session,
  type SessionId,
  type Status,
  type Todo,
} from "@wren/protocol"
import { createMemorySessionStore, type SessionStore, type SessionSummary } from "@wren/storage"
import type { Accessor } from "solid-js"
import { batch } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { z } from "zod"
import {
  createDualPathStore,
  projectDiff,
  projectMessageAdd,
  projectMessageAddBeforeQueued,
  projectMessageRemove,
  projectPreview,
  projectSessionCreation,
  projectSessionDeletion,
  projectSessionEffort,
  projectSessionModel,
  projectSessionPermissionMode,
  projectStatus,
  projectTodos,
} from "./app-bridge"
import {
  AdapterPayloadError,
  inferDisplayType,
  isFileEditTool,
  isReadOnlyTool,
  json,
  notFound,
  parseCreateSessionBody,
  parseEffortBody,
  parseGoalBody,
  parseModelBody,
  parsePermissionModeBody,
  parsePermissionReply,
  parsePromptBody,
  parseQuestionReply,
  readJson,
  workingStatus,
} from "./local-adapter-helpers"
import { consumeSDKMessageStream, recomputeMessageProjections } from "./message-mapper"
import { type CompactProgress, createTuiStore, type TuiStoreApi } from "./store"

type FileHistoryRestoreFile = { readonly path: string; readonly expectedContent: string | null }
type FileHistoryRestoreResult =
  | { status: "restored"; restoredPaths: string[] }
  | { status: "conflict"; conflictedPaths: string[] }
  | { status: "unavailable"; reason: string }

type FileHistoryEngine = WrenEngine & {
  restoreFileHistory?: (
    messageId: string,
    files: readonly FileHistoryRestoreFile[],
  ) => Promise<FileHistoryRestoreResult>
}

function fileHistoryEngine(engine: WrenEngine): FileHistoryEngine {
  return engine as FileHistoryEngine
}

export type WrenAdapterOptions = {
  readonly sessionStore?: SessionStore
  readonly clock?: { readonly now: () => string }
  readonly wirePermissionResolver?: boolean
  readonly engineFactory?: WrenEngineFactory
  readonly cwd?: string
  /**
   * Restore engine messages from the engine_event store (replaces the
   * pre-v10 engine_snapshot blob). Returns engine messages for resume,
   * or null if no events exist for this session.
   */
  readonly restoreEngineMessages?: (sessionId: string) => Promise<{
    readonly engineSessionId: string
    readonly messages: readonly unknown[]
    readonly goalState?: unknown
  } | null>
}

type SessionRuntime = {
  engine: WrenEngine
  runningPrompt: Promise<void> | null
  activeForResolver: boolean
  pendingModelChange: string | null
  queuedPrompts: {
    prompt: string
    messageId: Message["id"]
    disableGoalContinuation?: boolean
  }[]
  compactSavedQueuedMessages: Message[] | null
  pendingCompactProgress: CompactProgress | null
  compactProgressFlushTimer: ReturnType<typeof setTimeout> | null
  compactProgressActive: boolean
  aborted: boolean
  lastRunFailed: boolean
  goalGeneration: number
}

type EditAnchorSnapshot = {
  readonly messageId: Message["id"]
  readonly engineCount: number
}

type FileRollbackFile = {
  readonly path: string
  readonly expectedContent: string | null
}

type FileRollbackRecord = {
  readonly baselineMessageId: string
  readonly files: readonly FileRollbackFile[]
}

type EditTransactionSnapshot = {
  readonly messages: readonly Message[]
  readonly todos: readonly Todo[]
  readonly diff: Diff
  readonly status: Status
  readonly permissionMode: string
  readonly engineHistory: EngineHistorySnapshot
  readonly anchors: readonly EditAnchorSnapshot[]
  readonly permissions: readonly PermissionRequest[]
  readonly questions: readonly QuestionRequest[]
  readonly fileRollback?: FileRollbackRecord
}

const FILE_ROLLBACK_TOOLS = new Set([
  "edit",
  "fileedittool",
  "write",
  "filewritetool",
  "notebookedit",
  "notebookedittool",
])

function collectFileRollbackFiles(
  messages: readonly Message[],
  startIndex: number,
): FileRollbackFile[] {
  const files = new Map<string, FileRollbackFile>()
  for (const message of messages.slice(startIndex)) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool_use" || part.status !== "completed") continue
      if (!FILE_ROLLBACK_TOOLS.has(part.toolName.toLowerCase())) continue
      const input = part.input as Record<string, unknown> | null
      if (input === null || typeof input !== "object") continue
      const output = part.output as Record<string, unknown> | undefined
      const path = String(input.file_path ?? input.notebook_path ?? input.filePath ?? "")
      if (!path) continue
      const expectedContent = expectedFileContent(input, output)
      if (expectedContent === undefined) continue
      files.set(path, { path, expectedContent })
    }
  }
  return [...files.values()]
}

function expectedFileContent(
  input: Record<string, unknown>,
  output: Record<string, unknown> | undefined,
): string | null | undefined {
  if (typeof output?.content === "string") return output.content
  if (typeof output?.updated_file === "string") return output.updated_file
  if (typeof output?.originalFile === "string") {
    const oldString = typeof output.oldString === "string" ? output.oldString : input.old_string
    const newString = typeof output.newString === "string" ? output.newString : input.new_string
    if (typeof oldString !== "string" || typeof newString !== "string") return undefined
    return output.replaceAll === true
      ? output.originalFile.replaceAll(oldString, newString)
      : output.originalFile.replace(oldString, newString)
  }
  return undefined
}

function rollbackFromMessages(
  messages: readonly Message[],
  editIndex: number,
  editMessageId: string,
): FileRollbackRecord | undefined {
  const files = collectFileRollbackFiles(messages, editIndex)
  return files.length === 0 ? undefined : { baselineMessageId: editMessageId, files }
}

function rollbackFailureMessage(result: {
  status: "conflict" | "unavailable"
  conflictedPaths?: string[]
  reason?: string
}): string {
  if (result.status === "conflict") {
    return `filesystem rollback conflict: ${(result.conflictedPaths ?? []).join(", ")}`
  }
  return `filesystem rollback unavailable: ${result.reason ?? "unknown reason"}`
}

async function captureRollbackContents(
  files: readonly FileRollbackFile[],
): Promise<Map<string, string | null>> {
  const contents = new Map<string, string | null>()
  for (const file of files) {
    try {
      contents.set(file.path, await readFile(file.path, "utf8"))
    } catch {
      contents.set(file.path, null)
    }
  }
  return contents
}

async function restoreRollbackContents(contents: Map<string, string | null>): Promise<void> {
  for (const [filePath, content] of contents) {
    if (content === null) {
      await unlink(filePath).catch(() => {})
    } else {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content, "utf8")
    }
  }
}

type CompactEditSnapshot = {
  readonly messageId: Message["id"]
  readonly sessionId: SessionId
  readonly snapshot: EditTransactionSnapshot
}

type RunPromptResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reported: true; readonly message: string }

export type WrenAdapter = {
  fetch(request: Request): Promise<Response>
  resume(): Promise<void>
  readonly state: TuiStoreApi
  /** Reactive map of session ID → user-defined title (empty string if unset). */
  readonly titles?: Accessor<Readonly<Record<string, string>>>
  /** Await the in-flight prompt (resolves immediately if none is running). */
  waitForIdle(sessionId: SessionId): Promise<void>
  /** Whether the most recent runPrompt for this session ended in failure. */
  getLastRunFailed(sessionId: SessionId): boolean
}

type PermissionOutcome =
  | { readonly behavior: "allow"; readonly updatedInput?: unknown }
  | { readonly behavior: "deny"; readonly message?: string }

type PendingPermission = {
  readonly sessionId: SessionId
  readonly toolName: string
  readonly resolve: (outcome: PermissionOutcome) => void
}

type PendingQuestionGroup = {
  readonly sessionId: SessionId
  readonly remaining: Set<string>
  readonly answers: Record<string, string>
  readonly questionTextById: Map<string, string>
  readonly resolve: (answers: Record<string, string> | null) => void
}

const INTERNAL_ORIGIN = "http://wren.internal"

export function createWrenAdapter(engine: WrenEngine, options?: WrenAdapterOptions): WrenAdapter {
  const state = createTuiStore()
  const [titlesStore, setTitlesStore] = createStore<Record<string, string>>({})
  const clock = options?.clock ?? { now: () => new Date().toISOString() }
  const sessionStore: SessionStore = options?.sessionStore ?? createMemorySessionStore()
  const wireResolver = options?.wirePermissionResolver ?? true
  const factory = options?.engineFactory
  const adapterCwd = options?.cwd ?? process.cwd()
  const restoreEngineMessages = options?.restoreEngineMessages

  // Application layer — the new mutation authority behind the adapter facade.
  // The adapter projects mutations into both the Solid store (for the TUI)
  // and the ApplicationState (for the future @wren/client path).
  const app = new WrenApplication({
    sessionStore,
    engineFactory:
      factory ??
      ({
        createEngine: () => Promise.resolve(engine),
        getDefaultModel: () => engine.getModel(),
        getCommands: () => [],
        getAgents: () => [],
        getAgentTranscript: async () => null,
        getEngineSessionId: () => "",
        dispose: () => {},
      } as WrenEngineFactory),
    workspaceId: adapterCwd,
    workspaceLabel: adapterCwd,
  })

  // Dual-path store: wraps the Solid store so that every mutation (including
  // those from message-mapper) is mirrored into ApplicationState.
  const dualState = createDualPathStore(state, app)

  const pendingPermissions = new Map<string, PendingPermission>()
  const pendingQuestions = new Map<string, PendingQuestionGroup>()
  const sessionAllowSet = new Set<string>()
  const sessionRuntimes = new Map<string, SessionRuntime>()
  const userMessageEngineCounts = new Map<string, number>()
  const compactEditSnapshots = new Map<string, CompactEditSnapshot>()
  const manualPlanSessions = new Set<string>()
  const compactCallbackEngines = new WeakSet<WrenEngine>()
  const loadedMessageSessions = new Set<string>()
  const loadingMessageSessions = new Map<string, Promise<void>>()
  const persistQueues = new Map<string, Promise<void>>()
  let hasRestoredSessions = false

  /**
   * Serialize all storage writes for a given session so that a full save
   * (DELETE + rewrite) never races with a concurrent meta-only save or
   * another full save. Each write waits for the previous one to finish
   * before reading store state and writing.
   */
  function serializedPersist(sessionId: SessionId, write: () => Promise<void>): Promise<void> {
    const prev = persistQueues.get(sessionId) ?? Promise.resolve()
    const next = prev.then(write, write)
    persistQueues.set(
      sessionId,
      next.then(
        () => {},
        () => {},
      ),
    )
    return next
  }

  async function ensureSessionLoaded(sessionId: SessionId): Promise<void> {
    if (loadedMessageSessions.has(sessionId)) return
    const pending = loadingMessageSessions.get(sessionId)
    if (pending !== undefined) return pending

    const loading = (async (): Promise<void> => {
      const loadResult = await sessionStore.load(sessionId)
      if (!loadResult.ok) return
      const bundle = loadResult.value
      // Guard against the hydrate race: if messages were added to the store
      // while loading from the database (e.g., the user sent a prompt during
      // the initial session load), don't clobber them with the stale persisted
      // set. Engine snapshot and other metadata are still loaded.
      const currentMessages = dualState.store.messages[sessionId]
      if (currentMessages === undefined || currentMessages.length === 0) {
        dualState.hydrateSessionMessages(sessionId, bundle.messages)
      }
      if (bundle.todos.length > 0) {
        projectTodos(state, app, sessionId, bundle.todos)
      }
      if (bundle.diff.length > 0) {
        projectDiff(state, app, {
          sessionId,
          files: bundle.diff,
          updatedAt: clock.now(),
        })
      }
      if (restoreEngineMessages !== undefined) {
        const restored = await restoreEngineMessages(sessionId)
        if (restored !== null) {
          pendingEngineSnapshots.set(sessionId, {
            engineSessionId: restored.engineSessionId,
            messages: restored.messages,
            ...(restored.goalState !== undefined && { goalState: restored.goalState }),
          })
          engineSessionIds.set(sessionId, restored.engineSessionId)
          rebuildEngineCounts(sessionId, bundle.messages, restored.messages)
        }
      }
      loadedMessageSessions.add(sessionId)
    })()
    loadingMessageSessions.set(sessionId, loading)
    try {
      await loading
    } finally {
      loadingMessageSessions.delete(sessionId)
    }
  }

  let engineTurnTail: Promise<void> = Promise.resolve()

  async function withEngineTurn<T>(operation: () => Promise<T>): Promise<T> {
    const previous = engineTurnTail
    let release!: () => void
    engineTurnTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  function getOrCreateRuntime(sessionId: SessionId): SessionRuntime {
    const existing = sessionRuntimes.get(sessionId)
    if (existing !== undefined) return existing
    const runtime: SessionRuntime = {
      engine,
      runningPrompt: null,
      activeForResolver: false,
      pendingModelChange: null,
      queuedPrompts: [],
      compactSavedQueuedMessages: null,
      pendingCompactProgress: null,
      compactProgressFlushTimer: null,
      compactProgressActive: false,
      aborted: false,
      lastRunFailed: false,
      goalGeneration: 0,
    }
    sessionRuntimes.set(sessionId, runtime)
    return runtime
  }

  function getActiveSessionForResolver(): SessionId | null {
    for (const [id, runtime] of sessionRuntimes) {
      if (runtime.activeForResolver) return parseSessionId(id)
    }
    return null
  }

  function getEngine(sessionId: SessionId): WrenEngine {
    const runtime = sessionRuntimes.get(sessionId)
    if (runtime !== undefined) return runtime.engine
    return engine
  }

  function clearUserMessageEngineCounts(sessionId: SessionId): void {
    const bundle = state.getBundle(sessionId)
    for (const message of bundle?.messages ?? []) {
      if (message.role === "user") userMessageEngineCounts.delete(message.id)
    }
  }

  /**
   * Search compactEditSnapshots for a snapshot that covers the given editMessageId.
   * After a compact, all engine anchors are cleared. A compact snapshot captures
   * the full pre-compact state, so if the edited message existed before the
   * compact, we can restore from that snapshot to enable editing it.
   * Returns the most recent covering snapshot (the latest compact).
   */
  function findCoveringCompactSnapshot(
    snapshots: Map<string, CompactEditSnapshot>,
    sessionId: SessionId,
    editMessageId: string,
  ): CompactEditSnapshot | undefined {
    let latest: CompactEditSnapshot | undefined
    for (const snapshot of snapshots.values()) {
      if (snapshot.sessionId !== sessionId) continue
      const covers = snapshot.snapshot.messages.some(
        (message) => message.id === editMessageId && message.role === "user",
      )
      if (covers) {
        // Prefer the latest compact (highest message count = most recent state)
        if (
          latest === undefined ||
          snapshot.snapshot.messages.length > latest.snapshot.messages.length
        ) {
          latest = snapshot
        }
      }
    }
    return latest
  }

  function captureEditSnapshot(
    sessionId: SessionId,
    sessionEngine: WrenEngine,
  ): EditTransactionSnapshot | undefined {
    const session = state.getSession(sessionId)
    const bundle = state.getBundle(sessionId)
    if (session === undefined || bundle === undefined) return undefined
    const currentDiff = state.store.diffs[sessionId] ?? {
      sessionId,
      files: [],
      updatedAt: "",
    }
    return {
      messages: bundle.messages.map((message) => structuredClone(unwrap(message))),
      todos: bundle.todos.map((todo) => structuredClone(unwrap(todo))),
      diff: structuredClone(unwrap(currentDiff)),
      status: structuredClone(unwrap(bundle.status)),
      permissionMode: session.permissionMode,
      engineHistory: sessionEngine.snapshotHistory(),
      anchors: bundle.messages.flatMap((message) => {
        if (message.role !== "user") return []
        const engineCount = userMessageEngineCounts.get(message.id)
        return engineCount === undefined ? [] : [{ messageId: message.id, engineCount }]
      }),
      permissions: bundle.permissions.map((permission) => structuredClone(unwrap(permission))),
      questions: bundle.questions.map((question) => structuredClone(unwrap(question))),
    }
  }

  function restoreEditSnapshot(
    sessionId: SessionId,
    sessionEngine: WrenEngine,
    snapshot: EditTransactionSnapshot,
  ): void {
    sessionEngine.restoreHistory(snapshot.engineHistory)
    dualState.restoreConversation(sessionId, {
      messages: snapshot.messages,
      todos: snapshot.todos,
      status: snapshot.status,
      diff: snapshot.diff,
      permissionMode: snapshot.permissionMode,
      permissions: snapshot.permissions,
      questions: snapshot.questions,
    })
    clearUserMessageEngineCounts(sessionId)
    for (const anchor of snapshot.anchors) {
      userMessageEngineCounts.set(anchor.messageId, anchor.engineCount)
    }
  }

  function flushCompactProgress(sessionId: SessionId): void {
    const runtime = getOrCreateRuntime(sessionId)
    runtime.compactProgressFlushTimer = null
    const pending = runtime.pendingCompactProgress
    runtime.pendingCompactProgress = null
    if (pending !== null && runtime.compactProgressActive) {
      state.setCompactProgress(sessionId, pending)
    }
  }

  function queueCompactProgress(
    sessionId: SessionId,
    update: (previous: CompactProgress) => CompactProgress,
  ): void {
    const runtime = getOrCreateRuntime(sessionId)
    if (!runtime.compactProgressActive) return
    const previous =
      runtime.pendingCompactProgress ??
      state.store.compactProgress[sessionId] ??
      ({ phase: "preparing", segments: [] } satisfies CompactProgress)
    runtime.pendingCompactProgress = update(previous)
    if (runtime.compactProgressFlushTimer === null) {
      runtime.compactProgressFlushTimer = setTimeout(() => {
        flushCompactProgress(sessionId)
      }, 16)
    }
  }

  function clearCompactProgressState(sessionId: SessionId, deactivate = true): void {
    const runtime = getOrCreateRuntime(sessionId)
    if (deactivate) runtime.compactProgressActive = false
    runtime.pendingCompactProgress = null
    if (runtime.compactProgressFlushTimer !== null) {
      clearTimeout(runtime.compactProgressFlushTimer)
      runtime.compactProgressFlushTimer = null
    }
    if (state.store.compactProgress[sessionId] !== undefined) {
      state.clearCompactProgress(sessionId)
    }
  }

  function finishCompactProgress(sessionId: SessionId): void {
    const runtime = getOrCreateRuntime(sessionId)
    if (!runtime.compactProgressActive) return

    if (runtime.compactProgressFlushTimer !== null) {
      clearTimeout(runtime.compactProgressFlushTimer)
      runtime.compactProgressFlushTimer = null
    }
    const pending = runtime.pendingCompactProgress
    runtime.pendingCompactProgress = null
    runtime.compactProgressActive = false

    batch(() => {
      const current = pending ?? state.store.compactProgress[sessionId]
      if (current !== undefined) {
        state.setCompactProgress(sessionId, { ...current, phase: "finalizing" })
      }
      if (runtime.compactSavedQueuedMessages === null) {
        const queuedMessages =
          state.getBundle(sessionId)?.messages.filter((message) => message.queued === true) ?? []
        if (queuedMessages.length > 0) {
          runtime.compactSavedQueuedMessages = queuedMessages
          for (const message of queuedMessages) {
            projectMessageRemove(state, app, sessionId, message.id)
          }
        }
      }
    })
  }

  function registerCompactCallbacks(sessionEngine: WrenEngine, sessionId?: SessionId): void {
    if (compactCallbackEngines.has(sessionEngine)) return
    compactCallbackEngines.add(sessionEngine)
    const resolveSessionId = (): SessionId | null => sessionId ?? getActiveSessionForResolver()
    sessionEngine.setSDKStatusCallback?.((status) => {
      const activeSessionId = resolveSessionId()
      if (status === "compacting" && activeSessionId !== null) {
        projectStatus(state, app, activeSessionId, { type: "compacting" })
      }
    })
    sessionEngine.setOnCompactProgress?.((event: CompactProgressEvent) => {
      const activeSessionId = resolveSessionId()
      if (activeSessionId === null) return
      switch (event.type) {
        case "hooks_start": {
          const runtime = getOrCreateRuntime(activeSessionId)
          runtime.compactProgressActive = true
          queueCompactProgress(activeSessionId, (previous) => ({
            phase: event.hookType === "post_compact" ? "finalizing" : "preparing",
            segments: previous.segments,
          }))
          break
        }
        case "compact_start": {
          const runtime = getOrCreateRuntime(activeSessionId)
          runtime.compactProgressActive = true
          queueCompactProgress(activeSessionId, () => ({ phase: "summarizing", segments: [] }))
          break
        }
        case "summary_delta":
          queueCompactProgress(activeSessionId, (previous) => {
            const last = previous.segments[previous.segments.length - 1]
            const segments =
              last?.type === "text"
                ? [
                    ...previous.segments.slice(0, -1),
                    { type: "text" as const, text: last.text + event.text },
                  ]
                : [...previous.segments, { type: "text" as const, text: event.text }]
            return { phase: "summarizing", segments }
          })
          break
        case "thinking_delta":
          queueCompactProgress(activeSessionId, (previous) => {
            const last = previous.segments[previous.segments.length - 1]
            const segments =
              last?.type === "thinking"
                ? [
                    ...previous.segments.slice(0, -1),
                    { type: "thinking" as const, text: last.text + event.text },
                  ]
                : [...previous.segments, { type: "thinking" as const, text: event.text }]
            return { phase: "summarizing", segments }
          })
          break
        case "compact_end":
          finishCompactProgress(activeSessionId)
          break
      }
    })
  }

  function restoreCompactQueuedMessages(runtime: SessionRuntime): void {
    if (runtime.compactSavedQueuedMessages === null) return
    for (const message of runtime.compactSavedQueuedMessages) {
      projectMessageAdd(state, app, message)
    }
    runtime.compactSavedQueuedMessages = null
  }

  function clearTransientCompactState(sessionId: SessionId): void {
    const runtime = getOrCreateRuntime(sessionId)
    batch(() => {
      clearCompactProgressState(sessionId)
      const bundle = state.getBundle(sessionId)
      if (bundle?.status.type === "compacting") {
        projectStatus(state, app, sessionId, { type: "idle" })
      }
      restoreCompactQueuedMessages(runtime)
    })
  }

  const pendingEngineSnapshots = new Map<
    string,
    {
      readonly engineSessionId: string
      readonly messages: readonly unknown[]
      readonly goalState?: unknown
    }
  >()
  const engineSessionIds = new Map<string, string>()

  async function ensureSessionRuntime(
    sessionId: SessionId,
    model?: string,
    initialMessages?: readonly unknown[],
    effort?: string,
  ): Promise<WrenEngine> {
    const runtime = getOrCreateRuntime(sessionId)
    if (factory === undefined) {
      registerCompactCallbacks(runtime.engine)
      return runtime.engine
    }
    // If engine already upgraded from the shared placeholder, it's ready.
    if (runtime.engine !== engine) return runtime.engine

    const snapshot = pendingEngineSnapshots.get(sessionId)
    const messagesToUse = initialMessages ?? snapshot?.messages
    const goalState = snapshot?.goalState
    const sessionEngine = await factory.createEngine(sessionId, {
      ...(model !== undefined && { model }),
      ...(messagesToUse !== undefined && { initialMessages: messagesToUse }),
      ...(effort !== undefined && effort !== "default" && { effort }),
    })
    if (goalState !== undefined) {
      hydrateGoalFromState(goalState as GoalState, engineSessionIds.get(sessionId) ?? sessionId)
    }
    if (wireResolver) {
      sessionEngine.setPermissionResolver(createStoreResolver(sessionId))
    }
    runtime.engine = sessionEngine
    // Sync session's permissionMode to engine's toolPermissionContext.mode.
    // Only an explicit TUI mode selection creates a plan-exit approval boundary.
    const session = state.getSession(sessionId)
    if (session?.permissionMode) {
      sessionEngine.setPermissionMode?.(session.permissionMode, {
        source: manualPlanSessions.has(sessionId) ? "manual" : "automatic",
      })
    }
    // Register callback: when engine mode changes internally (EnterPlanMode/ExitPlanMode tools),
    // sync back to session.permissionMode so resolver and TUI see the change.
    sessionEngine.setPermissionModeChangeCallback?.((mode: string) => {
      manualPlanSessions.delete(sessionId)
      const currentSession = state.getSession(sessionId)
      if (currentSession?.permissionMode !== mode) {
        projectSessionPermissionMode(state, app, sessionId, mode)
        void persistSessionMeta(sessionId)
      }
    })
    registerCompactCallbacks(sessionEngine, sessionId)
    if (typeof factory.getEngineSessionId === "function") {
      engineSessionIds.set(sessionId, factory.getEngineSessionId())
    }
    pendingEngineSnapshots.delete(sessionId)
    return sessionEngine
  }

  function getDefaultModel(): string {
    return factory?.getDefaultModel() ?? engine.getModel()
  }

  if (wireResolver && factory === undefined) {
    engine.setPermissionResolver(createStoreResolver(null))
  }

  function createStoreResolver(resolvedSessionId: SessionId | null): PermissionResolver {
    return async (
      toolName: string,
      input: unknown,
      context?: PermissionResolverContext,
    ): Promise<PermissionOutcome> => {
      const sessionId = resolvedSessionId ?? getActiveSessionForResolver()
      if (sessionId === null) {
        return { behavior: "deny", message: "no active session" }
      }
      const runtime = getOrCreateRuntime(sessionId)
      if (runtime.aborted) {
        return { behavior: "deny", message: "session aborted" }
      }
      // Background agents that can't show UI — deny instead of hanging forever
      if (context?.shouldAvoidPermissionPrompts) {
        return { behavior: "deny", message: "permission prompts disabled for background agent" }
      }
      // AskUserQuestion always requires user interaction — never auto-allow
      // even in auto/plan/acceptEdits modes, otherwise the model gets empty
      // answers and the user never sees the question.
      if (toolName === "AskUserQuestion") {
        return askUserQuestion(sessionId, input)
      }
      const session = state.getSession(sessionId)
      const sessionMode = session?.permissionMode
      // Subagents resolve their own mode (runAgent); prefer it over the
      // session mode. Safe workspace reads under a plan-mode parent are
      // auto-allowed by the engine's plan check, so the resolver only
      // auto-allows read-only tools when the session is not in plan mode.
      const effectiveMode = context?.mode ?? sessionMode
      if (!context?.forcePrompt && effectiveMode === "full") {
        return { behavior: "allow" }
      }
      if (
        !context?.forcePrompt &&
        effectiveMode === "acceptEdits" &&
        (isFileEditTool(toolName) || (isReadOnlyTool(toolName) && sessionMode !== "plan"))
      ) {
        return { behavior: "allow" }
      }
      if (!context?.forcePrompt && sessionAllowSet.has(sessionAllowKey(sessionId, toolName))) {
        return { behavior: "allow" }
      }
      const requestId = parsePermissionId(`perm_${randomUUID()}`)
      dualState.setPermission({
        id: requestId,
        sessionId,
        toolName,
        input,
        displayType: inferDisplayType(toolName),
      })
      return new Promise<PermissionOutcome>((resolve) => {
        pendingPermissions.set(requestId, { sessionId, toolName, resolve })
      })
    }
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url, INTERNAL_ORIGIN)
    const path = url.pathname
    const method = request.method.toUpperCase()

    try {
      if (path === "/session" && method === "GET")
        return listSessions(url.searchParams.get("cwd") ?? undefined)
      if (path === "/session" && method === "POST") return createSession(await readJson(request))
      if (path === "/config" && method === "GET") return getConfig()
      if (path === "/config/default-model" && method === "POST")
        return await setDefaultModel(await readJson(request))
      const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(.+))?$/)
      if (sessionMatch) {
        const rawSessionId = decodeURIComponent(sessionMatch[1] ?? "")
        const sub = sessionMatch[2] ?? ""
        if (rawSessionId === "") return notFound("session_not_found", "session not found")
        const sessionId = parseSessionId(rawSessionId)

        if (sub === "" && method === "GET") return getSession(sessionId)
        if (sub === "" && method === "DELETE") return await deleteSession(sessionId)
        if (sub === "" && method === "PATCH")
          return await renameSession(sessionId, await readJson(request))
        if (sub === "messages" && method === "GET") return await getMessages(sessionId)
        if (sub === "message" && method === "POST")
          return await sendMessage(sessionId, await readJson(request))
        if (sub === "model" && method === "POST")
          return await setSessionModel(sessionId, await readJson(request))
        if (sub === "model/test" && method === "POST")
          return await testSessionModel(sessionId, await readJson(request))
        if (sub === "permission-mode" && method === "POST")
          return await setSessionPermissionMode(sessionId, await readJson(request))
        if (sub === "effort" && method === "POST")
          return await setSessionEffort(sessionId, await readJson(request))
        if (sub === "goal" && method === "POST")
          return await setSessionGoal(sessionId, await readJson(request))
        if (sub === "abort" && method === "POST") return abortSession(sessionId)
        if (sub === "clear" && method === "POST") return await clearSession(sessionId)
        if (sub === "export" && method === "GET") return exportSession(sessionId)
        if (sub === "context" && method === "GET") return getContext(sessionId)
        if (sub === "retry" && method === "POST") return await retryLastPrompt(sessionId)
        if (sub.startsWith("subagent/")) {
          const agentId = sub.slice("subagent/".length)
          if (method === "GET") {
            if (!isSafeAgentId(agentId)) {
              return notFound("subagent_not_found", `subagent transcript not found: ${agentId}`)
            }
            return await getSubagentTranscript(sessionId, agentId)
          }
        }
        if (sub.startsWith("permission/")) {
          const permId = sub.slice("permission/".length)
          if (method === "POST")
            return await replyPermission(sessionId, permId, await readJson(request))
        }
        if (sub.startsWith("question/")) {
          const qId = sub.slice("question/".length)
          if (method === "POST") return await replyQuestion(sessionId, qId, await readJson(request))
        }
      }

      return notFound("route_not_found", `route not found: ${method} ${path}`)
    } catch (error) {
      if (error instanceof AdapterPayloadError) {
        return json({ error: "invalid_request", message: error.message }, 400)
      }
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: "internal_error", message }, 500)
    }
  }

  function listSessions(cwd?: string): Response {
    let sessions = hasRestoredSessions
      ? state.store.sessions.slice().reverse()
      : state.store.sessions
    if (cwd !== undefined) {
      sessions = sessions.filter((s) => s.cwd === cwd)
    }
    return json(sessions)
  }

  function createSession(body: unknown): Response {
    const payload = parseCreateSessionBody(body)
    const modelId = payload.modelId ?? getDefaultModel()
    const effort = payload.effort ?? "default"
    const session: Session = {
      id: parseSessionId(`ses_${randomUUID()}`),
      cwd: payload.cwd,
      modelId,
      modelRef: selectedModelReference(modelId, effort),
      permissionMode: payload.permissionMode ?? "default",
      effort,
    }
    if (session.permissionMode === "plan" && payload.permissionModeSource === "manual") {
      manualPlanSessions.add(session.id)
    }
    projectSessionCreation(state, app, session)
    // A freshly created session is authoritative in memory — no need to
    // load from DB before persisting. Without this, persistSession would
    // fall back to saveSessionMeta (which skips messages) until /messages
    // is explicitly called.
    loadedMessageSessions.add(session.id)
    // Persist immediately so a session created without any prompt (e.g. via
    // the web GUI) survives a restart instead of being dropped.
    void persistSession(session.id)
    return json(session, 201)
  }

  function getSession(sessionId: SessionId): Response {
    const session = state.getSession(sessionId)
    if (session === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    return json(session)
  }

  async function getMessages(sessionId: SessionId): Promise<Response> {
    const session = state.getSession(sessionId)
    if (session === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    await ensureSessionLoaded(sessionId)
    const bundle = state.getBundle(sessionId)
    if (bundle === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    return json(bundle.messages)
  }

  async function sendMessage(sessionId: SessionId, body: unknown): Promise<Response> {
    const session = state.getSession(sessionId)
    if (session === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const runtime = getOrCreateRuntime(sessionId)
    const { prompt, editMessageId, disableGoalContinuation } = parsePromptBody(body)
    if (runtime.runningPrompt !== null) {
      if (editMessageId !== undefined) {
        await runtime.runningPrompt
        if (runtime.runningPrompt !== null) {
          return json(
            {
              error: "session_busy",
              message: "a newer run started while waiting for finalization",
            },
            409,
          )
        }
      } else {
        await ensureSessionLoaded(sessionId)
        const engineCount = getEngine(sessionId).getMessages().length
        const messageId = recordUserPrompt(sessionId, prompt, engineCount, true)
        runtime.queuedPrompts.push({
          prompt,
          messageId,
          ...(disableGoalContinuation === true && { disableGoalContinuation: true }),
        })
        return json({ ok: true, queued: true }, 202)
      }
    }

    // M15: Set a sentinel promise BEFORE any await so concurrent calls see busy.
    let sentinelResolve!: () => void
    const sentinel = new Promise<void>((resolve) => {
      sentinelResolve = resolve
    })
    runtime.runningPrompt = sentinel

    await ensureSessionLoaded(sessionId)

    let sessionEngine: WrenEngine | undefined
    let editSnapshot: EditTransactionSnapshot | undefined
    let editRollbackSnapshot: EditTransactionSnapshot | undefined
    let consumedCompactSnapshot: CompactEditSnapshot | undefined
    let filesystemRollbackContents: Map<string, string | null> | undefined
    try {
      sessionEngine = await ensureSessionRuntime(
        sessionId,
        session.modelId,
        undefined,
        session.effort,
      )
      sessionEngine.setModel(session.modelId)
      sessionEngine.setEffort?.(session.effort === "default" ? undefined : session.effort)
      if (editMessageId !== undefined) {
        const bundle = state.getBundle(sessionId)
        if (bundle === undefined) {
          runtime.runningPrompt = null
          sentinelResolve()
          return notFound("session_not_found", `session not found: ${sessionId}`)
        }
        const editIdx = bundle.messages.findIndex((message) => message.id === editMessageId)
        const editMessage = bundle.messages[editIdx]
        if (editMessage === undefined || editMessage.role !== "user") {
          runtime.runningPrompt = null
          sentinelResolve()
          return notFound(
            "edit_message_not_found",
            `editable user message not found: ${editMessageId}`,
          )
        }

        const storedCompactSnapshot = compactEditSnapshots.get(editMessageId)
        const coveringSnapshot = findCoveringCompactSnapshot(
          compactEditSnapshots,
          sessionId,
          editMessageId,
        )
        const rollbackSourceMessages = coveringSnapshot?.snapshot.messages ?? bundle.messages
        const rollbackStartIndex =
          coveringSnapshot === undefined
            ? editIdx + 1
            : Math.max(
                0,
                rollbackSourceMessages.findIndex((message) => message.id === editMessageId) + 1,
              )
        const rollbackRecord = rollbackFromMessages(
          rollbackSourceMessages,
          rollbackStartIndex,
          editMessageId,
        )
        const normalizedRollbackRecord =
          rollbackRecord === undefined
            ? undefined
            : {
                ...rollbackRecord,
                files: rollbackRecord.files.map((file) => ({
                  ...file,
                  path: path.isAbsolute(file.path)
                    ? file.path
                    : path.resolve(session.cwd, file.path),
                })),
              }
        const historyEngine = fileHistoryEngine(sessionEngine)
        if (normalizedRollbackRecord !== undefined) {
          filesystemRollbackContents = await captureRollbackContents(normalizedRollbackRecord.files)
        }
        if (
          normalizedRollbackRecord !== undefined &&
          historyEngine.restoreFileHistory !== undefined
        ) {
          const rollbackResult = await historyEngine.restoreFileHistory(
            normalizedRollbackRecord.baselineMessageId,
            normalizedRollbackRecord.files,
          )
          if (rollbackResult.status !== "restored") {
            await restoreRollbackContents(filesystemRollbackContents ?? new Map())
            runtime.runningPrompt = null
            runtime.activeForResolver = false
            sentinelResolve()
            return json(
              { error: "filesystem_rollback", message: rollbackFailureMessage(rollbackResult) },
              409,
            )
          }
        }

        if (storedCompactSnapshot !== undefined && storedCompactSnapshot.sessionId === sessionId) {
          consumedCompactSnapshot = storedCompactSnapshot
          editRollbackSnapshot = captureEditSnapshot(sessionId, sessionEngine)
          editSnapshot = storedCompactSnapshot.snapshot
          compactEditSnapshots.delete(editMessageId)
          sessionEngine.restoreHistory(editSnapshot.engineHistory)
          dualState.restoreConversation(sessionId, {
            messages: editSnapshot.messages,
            todos: editSnapshot.todos,
            status: editSnapshot.status,
            diff: editSnapshot.diff,
            permissionMode: editSnapshot.permissionMode,
            permissions: editSnapshot.permissions,
            questions: editSnapshot.questions,
          })
          state.clearCompactProgress(sessionId)
          clearUserMessageEngineCounts(sessionId)
          for (const anchor of editSnapshot.anchors) {
            userMessageEngineCounts.set(anchor.messageId, anchor.engineCount)
          }
          for (const [messageId, candidate] of compactEditSnapshots) {
            if (candidate.sessionId === sessionId && candidate.messageId !== editMessageId)
              compactEditSnapshots.delete(messageId)
          }
        } else {
          // No direct compact snapshot for this message. Check if a compact
          // snapshot from a later compact covers this message (i.e., the
          // message existed before the compact ran). If so, restore from
          // that snapshot so the user can edit messages from before a compact.
          const coveringSnapshot = findCoveringCompactSnapshot(
            compactEditSnapshots,
            sessionId,
            editMessageId,
          )
          if (coveringSnapshot !== undefined) {
            consumedCompactSnapshot = coveringSnapshot
            editRollbackSnapshot = captureEditSnapshot(sessionId, sessionEngine)
            editSnapshot = coveringSnapshot.snapshot
            compactEditSnapshots.delete(coveringSnapshot.messageId)
            sessionEngine.restoreHistory(editSnapshot.engineHistory)
            dualState.restoreConversation(sessionId, {
              messages: editSnapshot.messages,
              todos: editSnapshot.todos,
              status: editSnapshot.status,
              diff: editSnapshot.diff,
              permissionMode: editSnapshot.permissionMode,
              permissions: editSnapshot.permissions,
              questions: editSnapshot.questions,
            })
            state.clearCompactProgress(sessionId)
            clearUserMessageEngineCounts(sessionId)
            for (const anchor of editSnapshot.anchors) {
              userMessageEngineCounts.set(anchor.messageId, anchor.engineCount)
            }
            for (const [messageId, candidate] of compactEditSnapshots) {
              if (candidate.sessionId === sessionId && messageId !== coveringSnapshot.messageId)
                compactEditSnapshots.delete(messageId)
            }
          } else {
            const engineCount = userMessageEngineCounts.get(editMessageId)
            const engineMessages = sessionEngine.getMessages()
            const anchoredMessage =
              engineCount === undefined ? undefined : engineMessages[engineCount]
            if (
              engineCount === undefined ||
              !Number.isInteger(engineCount) ||
              engineCount < 0 ||
              engineCount >= engineMessages.length ||
              !isEngineUserPrompt(anchoredMessage)
            ) {
              runtime.runningPrompt = null
              sentinelResolve()
              return json(
                {
                  error: "edit_anchor_stale",
                  message: `engine history anchor is unavailable for: ${editMessageId}`,
                },
                409,
              )
            }

            const removedMessages = bundle.messages.slice(editIdx)
            const retainedSystemMessages = removedMessages.filter(
              (message) => message.role === "system",
            )
            const removedAnchors = removedMessages.flatMap((message) => {
              if (message.role !== "user") return []
              const count = userMessageEngineCounts.get(message.id)
              return count === undefined ? [] : [{ messageId: message.id, engineCount: count }]
            })
            const currentDiff = state.store.diffs[sessionId] ?? {
              sessionId,
              files: [],
              updatedAt: "",
            }
            editSnapshot = {
              messages: bundle.messages.map((message) => structuredClone(unwrap(message))),
              todos: bundle.todos.map((todo) => structuredClone(unwrap(todo))),
              diff: structuredClone(unwrap(currentDiff)),
              status: structuredClone(unwrap(bundle.status)),
              permissionMode: session.permissionMode,
              engineHistory: sessionEngine.snapshotHistory(),
              anchors: removedAnchors,
              permissions: bundle.permissions.map((p) => structuredClone(unwrap(p))),
              questions: bundle.questions.map((q) => structuredClone(unwrap(q))),
            }

            sessionEngine.truncateMessages(engineCount)
            dualState.removeMessagesFrom(sessionId, editMessage.id)
            for (const anchor of removedAnchors) {
              userMessageEngineCounts.delete(anchor.messageId)
            }
            const retainedMessages = state.getBundle(sessionId)?.messages ?? []
            recomputeMessageProjections(retainedMessages, { clock, sessionId, store: dualState })
            for (const message of retainedSystemMessages) {
              projectMessageAddBeforeQueued(state, app, message)
            }
          }
        }
      }

      const prePromptBundle = state.getBundle(sessionId)
      const compactSnapshot =
        isCompactPrompt(prompt) && prePromptBundle !== undefined
          ? {
              messageId: parseMessageId(`compact_pending_${randomUUID()}`),
              snapshot: {
                messages: prePromptBundle.messages.map((message) =>
                  structuredClone(unwrap(message)),
                ),
                todos: prePromptBundle.todos.map((todo) => structuredClone(unwrap(todo))),
                diff: structuredClone(
                  unwrap(
                    state.store.diffs[sessionId] ?? {
                      sessionId,
                      files: [],
                      updatedAt: "",
                    },
                  ),
                ),
                status: structuredClone(unwrap(prePromptBundle.status)),
                permissionMode:
                  state.getSession(sessionId)?.permissionMode ?? session.permissionMode,
                engineHistory: sessionEngine.snapshotHistory(),
                anchors: prePromptBundle.messages.flatMap((message) => {
                  if (message.role !== "user") return []
                  const engineCount = userMessageEngineCounts.get(message.id)
                  return engineCount === undefined ? [] : [{ messageId: message.id, engineCount }]
                }),
                permissions: prePromptBundle.permissions.map((permission) =>
                  structuredClone(unwrap(permission)),
                ),
                questions: prePromptBundle.questions.map((question) =>
                  structuredClone(unwrap(question)),
                ),
              },
            }
          : undefined

      const engineCountBefore = sessionEngine.getMessages().length
      const messageId = recordUserPrompt(sessionId, prompt, engineCountBefore)
      const savedCompactSnapshot =
        compactSnapshot === undefined ? undefined : { ...compactSnapshot, messageId, sessionId }

      runtime.activeForResolver = true
      projectStatus(state, app, sessionId, workingStatus(session.modelId))

      const actualPromise = runPrompt(sessionId, prompt, sessionEngine, runtime, {
        ...(disableGoalContinuation === true && { disableGoalContinuation: true }),
        uuid: messageId,
      })
      runtime.runningPrompt = actualPromise.then((result) => {
        if (result.ok && savedCompactSnapshot !== undefined) {
          compactEditSnapshots.set(messageId, savedCompactSnapshot)
          const snapshots = [...compactEditSnapshots.values()].filter((candidate) =>
            candidate.snapshot.messages.some((message) => message.sessionId === sessionId),
          )
          for (const candidate of snapshots.slice(0, -8)) {
            compactEditSnapshots.delete(candidate.messageId)
          }
        }
      })
      actualPromise.finally(() => sentinelResolve())
    } catch (error) {
      if (filesystemRollbackContents !== undefined) {
        await restoreRollbackContents(filesystemRollbackContents)
      }
      if (
        editRollbackSnapshot !== undefined &&
        sessionEngine !== undefined &&
        state.getSession(sessionId) !== undefined
      ) {
        restoreEditSnapshot(sessionId, sessionEngine, editRollbackSnapshot)
        if (consumedCompactSnapshot !== undefined) {
          compactEditSnapshots.set(consumedCompactSnapshot.messageId, consumedCompactSnapshot)
        }
      } else if (
        editSnapshot !== undefined &&
        sessionEngine !== undefined &&
        state.getSession(sessionId) !== undefined
      ) {
        restoreEditSnapshot(sessionId, sessionEngine, editSnapshot)
      }
      runtime.runningPrompt = null
      runtime.activeForResolver = false
      sentinelResolve()
      throw error
    }

    return json({ ok: true }, 202)
  }

  async function setSessionModel(sessionId: SessionId, body: unknown): Promise<Response> {
    const session = state.getSession(sessionId)
    if (session === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const { modelId } = parseModelBody(body)

    // Check if the current session effort is supported by the new model
    const registry = loadModelRegistry(adapterCwd)
    const newEntry = registry.entries.find((entry) => {
      if (entry.sourceName === undefined) return entry.ref.modelId === modelId
      return `${entry.sourceName}/${entry.ref.modelId}` === modelId
    })
    const currentEffort = session.effort
    let effortAdjusted: { old: string; new: string } | undefined

    if (currentEffort !== undefined && currentEffort !== "default") {
      if (newEntry?.efforts === undefined || newEntry.efforts.length === 0) {
        // New model doesn't use effort levels — clear the effort
        effortAdjusted = { old: currentEffort, new: "default" }
        projectSessionEffort(state, app, sessionId, "default")
      } else if (!newEntry.efforts.includes(currentEffort as (typeof newEntry.efforts)[number])) {
        // Current effort not supported by new model — clamp to default or model default
        const newEffort: string = newEntry.defaultEffort ?? "default"
        effortAdjusted = { old: currentEffort, new: newEffort }
        projectSessionEffort(state, app, sessionId, newEffort as NonNullable<Session["effort"]>)
      }
    } else if (currentEffort === undefined && newEntry?.defaultEffort !== undefined) {
      // No effort was set; if the new model has a default, apply it
      effortAdjusted = { old: "default", new: newEntry.defaultEffort }
      projectSessionEffort(state, app, sessionId, newEntry.defaultEffort)
    }

    projectSessionModel(
      state,
      app,
      sessionId,
      modelId,
      selectedModelReference(
        modelId,
        state.getSession(sessionId)?.effort ?? "default",
        newEntry?.sourceName,
      ),
    )
    const runtime = getOrCreateRuntime(sessionId)
    const isRunning = runtime.runningPrompt !== null
    if (isRunning) {
      runtime.pendingModelChange = modelId
    } else {
      const sessionEngine = getEngine(sessionId)
      sessionEngine.setModel(modelId)
      // Apply clamped effort to the engine
      const clampedEffort = state.getSession(sessionId)?.effort
      sessionEngine.setEffort?.(
        clampedEffort === undefined || clampedEffort === "default" ? undefined : clampedEffort,
      )
    }
    await persistSessionMeta(sessionId)
    const appliesTo = isRunning ? "next_turn" : "current"
    return json({
      ok: true,
      modelId,
      appliesTo,
      ...(effortAdjusted !== undefined && { effortAdjusted }),
      diagnostics: {
        logicalModel: modelId,
        providerId: undefined,
        envOverrides: [],
      },
    })
  }

  async function testSessionModel(sessionId: SessionId, body: unknown): Promise<Response> {
    if (state.getSession(sessionId) === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const { modelId } = parseModelBody(body)
    const runtime = getOrCreateRuntime(sessionId)
    if (runtime.runningPrompt === null) {
      const engine = runtime.engine
      const originalModel = engine.getModel()
      try {
        engine.setModel(modelId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ ok: false, modelId, error: message }, 400)
      }
      engine.setModel(originalModel)
    }
    return json({
      ok: true,
      modelId,
      effectiveModelId: modelId,
      diagnostics: {
        probe: "ok",
        message: "model accepted",
      },
    })
  }

  async function setSessionEffort(sessionId: SessionId, body: unknown): Promise<Response> {
    const session = state.getSession(sessionId)
    if (session === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)

    const effort = parseEffortBody(body)

    // Look up the model's supported effort levels from the catalog
    const registry = loadModelRegistry(adapterCwd)
    const entry = registry.entries.find((candidate) => {
      if (candidate.sourceName === undefined) return candidate.ref.modelId === session.modelId
      return `${candidate.sourceName}/${candidate.ref.modelId}` === session.modelId
    })

    if (entry !== undefined && (entry.efforts === undefined || entry.efforts.length === 0)) {
      return json(
        {
          ok: false,
          error: "unsupported",
          message: `model "${session.modelId}" does not support effort levels`,
        },
        400,
      )
    }
    if (
      entry?.efforts !== undefined &&
      !entry.efforts.includes(effort as (typeof entry.efforts)[number])
    ) {
      return json(
        {
          ok: false,
          error: "invalid_command",
          message: `effort "${effort}" is not supported by model "${session.modelId}". Supported: ${entry.efforts.join(", ")}`,
        },
        400,
      )
    }

    projectSessionEffort(state, app, sessionId, effort)
    const engine = await ensureSessionRuntime(sessionId, session.modelId, undefined, effort)
    engine.setEffort?.(effort === "default" ? undefined : effort)
    await persistSessionMeta(sessionId)
    return json({ ok: true, effort })
  }

  async function setSessionGoal(sessionId: SessionId, body: unknown): Promise<Response> {
    const session = state.getSession(sessionId)
    if (session === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const { action, objective } = parseGoalBody(body)
    await ensureSessionRuntime(sessionId, session.modelId, undefined, session.effort)
    // goalState is keyed by engineSessionId; adapter tracks the mapping.
    const goalSessionId = engineSessionIds.get(sessionId) ?? sessionId
    const engine = await import("@wren/engine")

    switch (action) {
      case "status": {
        const goal = engine.getGoal(goalSessionId)
        if (goal === null) return json({ goal: null, maxTurns: engine.MAX_GOAL_TURNS })
        return json({
          goal: {
            objective: goal.objective,
            status: engine.formatGoalStatusLabel(goal.status),
            rawStatus: goal.status,
            tokensUsed: goal.tokensUsed,
            tokenBudget: goal.tokenBudget,
            turnsExecuted: goal.turnsExecuted,
            maxTurns: engine.MAX_GOAL_TURNS,
            elapsed: engine.formatGoalElapsed(goal),
          },
        })
      }
      case "set": {
        const runtime = getOrCreateRuntime(sessionId)
        runtime.goalGeneration++
        const previousGoal = engine.getGoal(goalSessionId)
        // biome-ignore lint/style/noNonNullAssertion: objective is validated by the "set" case
        engine.setGoal(objective!, { sessionId: goalSessionId })
        engine.persistCurrentGoal(goalSessionId)
        const systemMessageId = recordSystemMessage(
          sessionId,
          // biome-ignore lint/style/noNonNullAssertion: objective validated by "set" case
          `${previousGoal === null ? "Goal set" : "Goal updated"}: ${objective!}`,
        )
        try {
          await persistSession(sessionId)
        } catch (error) {
          projectMessageRemove(state, app, sessionId, systemMessageId)
          throw error
        }
        if (runtime.runningPrompt === null) {
          void startGoalContinuation(sessionId)
        }
        // biome-ignore lint/style/noNonNullAssertion: objective validated by "set" case
        return json({ ok: true, objective: objective!, maxTurns: engine.MAX_GOAL_TURNS })
      }
      case "clear": {
        const runtime = getOrCreateRuntime(sessionId)
        runtime.goalGeneration++
        const cleared = engine.clearGoal(goalSessionId)
        if (cleared) {
          engine.persistGoalClear(goalSessionId)
          await persistSessionMeta(sessionId)
        }
        return json({ ok: true, cleared })
      }
      case "pause": {
        const runtime = getOrCreateRuntime(sessionId)
        runtime.goalGeneration++
        const g = engine.pauseGoal(goalSessionId)
        if (g) {
          engine.persistCurrentGoal(goalSessionId)
          await persistSessionMeta(sessionId)
        }
        return json({ ok: true, paused: g !== null })
      }
      case "resume": {
        const runtime = getOrCreateRuntime(sessionId)
        runtime.goalGeneration++
        const g = engine.resumeGoal(goalSessionId)
        if (g) {
          engine.persistCurrentGoal(goalSessionId)
          await persistSessionMeta(sessionId)
        }
        if (g && runtime.runningPrompt === null) {
          void startGoalContinuation(sessionId)
        }
        return json({ ok: true, resumed: g !== null })
      }
      case "complete": {
        const runtime = getOrCreateRuntime(sessionId)
        runtime.goalGeneration++
        const g = engine.completeGoal(goalSessionId)
        if (g) {
          engine.persistCurrentGoal(goalSessionId)
          await persistSessionMeta(sessionId)
        }
        return json({ ok: true, completed: g !== null })
      }
      case "continue": {
        const runtime = getOrCreateRuntime(sessionId)
        runtime.goalGeneration++
        const g = engine.continueGoalFromMaxTurns(goalSessionId)
        if (g) {
          engine.persistCurrentGoal(goalSessionId)
          await persistSessionMeta(sessionId)
        }
        if (g && runtime.runningPrompt === null) {
          void startGoalContinuation(sessionId)
        }
        return json({ ok: true, continued: g !== null })
      }
      default:
        return json({ error: "invalid_action" }, 400)
    }
  }

  async function setSessionPermissionMode(sessionId: SessionId, body: unknown): Promise<Response> {
    if (state.getSession(sessionId) === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const { permissionMode, source } = parsePermissionModeBody(body)
    if (permissionMode === "plan" && source === "manual") {
      manualPlanSessions.add(sessionId)
    } else {
      manualPlanSessions.delete(sessionId)
    }
    projectSessionPermissionMode(state, app, sessionId, permissionMode)
    // Sync to engine's toolPermissionContext.mode
    const engine = getEngine(sessionId)
    engine.setPermissionMode?.(permissionMode, { source })
    await persistSessionMeta(sessionId)
    return json({ ok: true, permissionMode })
  }

  async function renameSession(sessionId: SessionId, body: unknown): Promise<Response> {
    if (state.getSession(sessionId) === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    if (body === null || typeof body !== "object") {
      throw new AdapterPayloadError("invalid rename body")
    }
    const title = (body as Record<string, unknown>).title
    if (typeof title !== "string" || title.trim() === "") {
      throw new AdapterPayloadError("title is required")
    }
    const trimmed = title.trim()
    setTitlesStore(sessionId, trimmed)
    await persistSessionMeta(sessionId)
    return json({ ok: true, title: trimmed })
  }

  async function runPrompt(
    sessionId: SessionId,
    prompt: string,
    sessionEngine: WrenEngine,
    runtime: SessionRuntime,
    runOptions?: { isMeta?: boolean; disableGoalContinuation?: boolean; uuid?: string },
  ): Promise<RunPromptResult> {
    let hadFailure = false
    runtime.aborted = false
    runtime.lastRunFailed = false
    try {
      let failure: { readonly message: string; readonly reported: boolean } | undefined
      try {
        const result = await withEngineTurn(async () => {
          const stream = sessionEngine.submitMessage(prompt, runOptions)
          return consumeSDKMessageStream(stream, {
            clock,
            sessionId,
            store: dualState,
            onTurnBoundary: () => {
              if (runtime.queuedPrompts.length > 0) {
                sessionEngine.requestYield?.()
              }
            },
            onCompactBoundary: () => {
              clearCompactProgressState(sessionId, false)
              // The engine spliced its internal history, so all display-message
              // anchors must be invalidated. The transcript itself remains visible.
              const bundle = state.getBundle(sessionId)
              if (bundle !== undefined) {
                for (const m of bundle.messages) {
                  userMessageEngineCounts.delete(m.id)
                }
              }
            },
          })
        })
        if (!result.ok) failure = result
      } catch (error) {
        failure = {
          message: error instanceof Error ? error.message : String(error),
          reported: false,
        }
      }
      if (failure === undefined) return { ok: true }

      hadFailure = true
      if (state.getSession(sessionId) !== undefined) {
        if (!failure.reported) {
          projectStatus(state, app, sessionId, { type: "idle" })
          recordErrorAsMessage(sessionId, failure.message)
        }
      }
      return { ok: false, reported: true, message: failure.message }
    } finally {
      runtime.activeForResolver = false
      clearTransientCompactState(sessionId)
      runtime.lastRunFailed = hadFailure
      resolvePendingPermissions(sessionId, { behavior: "deny", message: "aborted" })
      resolvePendingQuestions(sessionId)
      const currentBundle = state.getBundle(sessionId)
      if (currentBundle !== undefined && currentBundle.status.type === "working") {
        projectStatus(state, app, sessionId, { type: "idle" })
      }
      sessionEngine.resetAbortController()
      sessionEngine.resetYieldRequest?.()
      if (runtime.pendingModelChange !== null) {
        sessionEngine.setModel(runtime.pendingModelChange)
        runtime.pendingModelChange = null
      }
      if (state.getSession(sessionId) !== undefined) {
        void persistSession(sessionId).catch(() => {})
      }
      runtime.runningPrompt = null
      if (runtime.queuedPrompts.length > 0 && state.getSession(sessionId) !== undefined) {
        // biome-ignore lint/style/noNonNullAssertion: checked length > 0 above
        const next = runtime.queuedPrompts.shift()!
        let qResolve!: () => void
        const qSentinel = new Promise<void>((resolve) => {
          qResolve = resolve
        })
        runtime.runningPrompt = qSentinel
        void startQueuedPrompt(
          sessionId,
          next.prompt,
          next.messageId,
          runtime,
          qResolve,
          next.disableGoalContinuation === true,
        )
      } else if (
        state.getSession(sessionId) !== undefined &&
        !runtime.aborted &&
        !hadFailure &&
        runOptions?.disableGoalContinuation !== true
      ) {
        void startGoalContinuation(sessionId)
      }
    }
  }

  async function startGoalContinuation(sessionId: SessionId): Promise<void> {
    const session = state.getSession(sessionId)
    if (session === undefined) return
    const runtime = getOrCreateRuntime(sessionId)
    if (runtime.runningPrompt !== null) return
    const generation = runtime.goalGeneration
    const goalSessionId = engineSessionIds.get(sessionId) ?? sessionId
    const engine = await import("@wren/engine")
    if (
      state.getSession(sessionId) === undefined ||
      runtime.goalGeneration !== generation ||
      runtime.runningPrompt !== null
    ) {
      return
    }
    const goal = engine.getGoal(goalSessionId)
    if (goal === null || goal.status !== "active") return
    if (goal.turnsExecuted >= engine.MAX_GOAL_TURNS) {
      engine.markGoalMaxTurnsReached(goalSessionId)
      engine.persistCurrentGoal(goalSessionId)
      return
    }
    engine.incrementGoalTurns(goalSessionId)
    engine.persistCurrentGoal(goalSessionId)
    const prompt = engine.buildContinuationPrompt(goal)
    let qResolve!: () => void
    const qSentinel = new Promise<void>((resolve) => {
      qResolve = resolve
    })
    runtime.runningPrompt = qSentinel
    void startGoalPrompt(sessionId, prompt, runtime, generation, qResolve)
  }

  async function startGoalPrompt(
    sessionId: SessionId,
    prompt: string,
    runtime: SessionRuntime,
    generation: number,
    sentinelResolve: () => void,
  ): Promise<void> {
    const session = state.getSession(sessionId)
    if (session === undefined || runtime.goalGeneration !== generation) {
      runtime.runningPrompt = null
      sentinelResolve()
      return
    }
    try {
      const sessionEngine = await ensureSessionRuntime(sessionId, session.modelId)
      if (state.getSession(sessionId) === undefined || runtime.goalGeneration !== generation) {
        runtime.runningPrompt = null
        sentinelResolve()
        return
      }
      sessionEngine.setModel(session.modelId)
      sessionEngine.setEffort?.(session.effort === "default" ? undefined : session.effort)
      runtime.activeForResolver = true
      projectStatus(state, app, sessionId, workingStatus(session.modelId))
      const actualPromise = runPrompt(sessionId, prompt, sessionEngine, runtime, { isMeta: true })
      runtime.runningPrompt = actualPromise.then(() => undefined)
      actualPromise.finally(() => sentinelResolve())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (state.getSession(sessionId) !== undefined) {
        recordErrorAsMessage(sessionId, message)
        projectStatus(state, app, sessionId, { type: "idle" })
      }
      runtime.runningPrompt = null
      runtime.activeForResolver = false
      sentinelResolve()
    }
  }

  async function startQueuedPrompt(
    sessionId: SessionId,
    prompt: string,
    messageId: Message["id"],
    runtime: SessionRuntime,
    sentinelResolve: () => void,
    disableGoalContinuation = false,
  ): Promise<void> {
    const session = state.getSession(sessionId)
    if (session === undefined) {
      runtime.runningPrompt = null
      sentinelResolve()
      return
    }

    try {
      const sessionEngine = await ensureSessionRuntime(sessionId, session.modelId)
      sessionEngine.setModel(session.modelId)
      sessionEngine.setEffort?.(session.effort === "default" ? undefined : session.effort)

      const engineCountBefore = sessionEngine.getMessages().length
      userMessageEngineCounts.set(messageId, engineCountBefore)
      dualState.clearMessageQueued(sessionId, messageId)

      runtime.activeForResolver = true
      projectStatus(state, app, sessionId, workingStatus(session.modelId))

      const actualPromise = runPrompt(sessionId, prompt, sessionEngine, runtime, {
        ...(disableGoalContinuation && { disableGoalContinuation: true }),
        uuid: messageId,
      })
      runtime.runningPrompt = actualPromise.then(() => undefined)
      actualPromise.finally(() => sentinelResolve())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (state.getSession(sessionId) !== undefined) {
        recordErrorAsMessage(sessionId, message)
        projectStatus(state, app, sessionId, { type: "idle" })
      }
      runtime.runningPrompt = null
      runtime.activeForResolver = false
      sentinelResolve()
    }
  }

  function abortSession(sessionId: SessionId): Response {
    if (state.getSession(sessionId) === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const runtime = getOrCreateRuntime(sessionId)
    runtime.goalGeneration++
    const sessionEngine = runtime.engine
    runtime.aborted = true
    const queuedMessageIds = new Set(runtime.queuedPrompts.map((queued) => queued.messageId))
    runtime.queuedPrompts = []
    const bundle = state.getBundle(sessionId)
    for (const message of bundle?.messages ?? []) {
      if (message.queued === true) queuedMessageIds.add(message.id)
    }
    for (const message of runtime.compactSavedQueuedMessages ?? []) {
      if (message.queued === true) queuedMessageIds.add(message.id)
    }
    runtime.compactSavedQueuedMessages = null
    clearTransientCompactState(sessionId)
    for (const messageId of queuedMessageIds) {
      projectMessageRemove(state, app, sessionId, messageId)
      userMessageEngineCounts.delete(messageId)
    }
    sessionEngine.interrupt()
    if (runtime.runningPrompt === null) {
      sessionEngine.resetAbortController()
    }
    resolvePendingPermissions(sessionId, { behavior: "deny", message: "aborted" })
    resolvePendingQuestions(sessionId)
    return json({ ok: true })
  }

  async function clearSession(sessionId: SessionId): Promise<Response> {
    if (state.getSession(sessionId) === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const runtime = getOrCreateRuntime(sessionId)
    if (runtime.runningPrompt !== null) {
      return json({ error: "session_busy", message: "cannot clear while a prompt is running" }, 409)
    }
    runtime.goalGeneration++
    const goalSessionId = engineSessionIds.get(sessionId) ?? sessionId
    const goalEngine = await import("@wren/engine")
    if (goalEngine.clearGoal(goalSessionId)) {
      goalEngine.persistGoalClear(goalSessionId)
    }
    runtime.queuedPrompts = []
    const engine = getEngine(sessionId)
    engine.truncateMessages(0)
    const bundle = state.getBundle(sessionId)
    if (bundle !== undefined) {
      const messages = [...bundle.messages]
      for (const msg of messages) {
        projectMessageRemove(state, app, sessionId, msg.id)
        userMessageEngineCounts.delete(msg.id)
      }
      projectTodos(state, app, sessionId, [])
      projectDiff(state, app, { sessionId, files: [], updatedAt: clock.now() })
      projectStatus(state, app, sessionId, { type: "idle" })
      for (const perm of bundle.permissions) {
        dualState.resolvePermission(sessionId, perm.id)
      }
      for (const question of bundle.questions) {
        dualState.resolveQuestion(sessionId, question.id)
      }
    }
    // Reset engine's toolPermissionContext.mode to match session's permissionMode
    // (prevents stale plan mode from EnterPlanMode tool lingering after /clear)
    const session = state.getSession(sessionId)
    if (session?.permissionMode) {
      engine.setPermissionMode?.(session.permissionMode, {
        source: manualPlanSessions.has(sessionId) ? "manual" : "automatic",
      })
    }
    // clearSession must do a full save (DELETE + rewrite) to remove all messages.
    // Don't use persistSession — its guard would see store messages < db messages
    // and fall back to saveSessionMeta, which preserves old messages.
    // Route through serializedPersist so this save waits for any in-flight
    // fire-and-forget persistSession to finish first, preventing a stale write
    // from restoring deleted messages after clear.
    await serializedPersist(sessionId, async () => {
      const bundle2 = state.getBundle(sessionId)
      if (bundle2 !== undefined) {
        const title = titlesStore[sessionId]
        const sessionToSave =
          title !== undefined && title !== "" ? { ...bundle2.session, title } : bundle2.session
        await sessionStore.save({
          session: sessionToSave,
          status: bundle2.status,
          messages: bundle2.messages,
          todos: bundle2.todos,
          permissions: bundle2.permissions,
          diff: bundle2.diff,
        })
      }
    })
    return json({ ok: true })
  }

  function exportSession(sessionId: SessionId): Response {
    const bundle = state.getBundle(sessionId)
    if (bundle === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const markdown = bundle.messages
      .map((m) => {
        const role =
          m.role === "user" ? "## User" : m.role === "assistant" ? "## Wren" : "## System"
        const text = m.parts
          .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n\n")
        return `${role}\n\n${text}`
      })
      .join("\n\n---\n\n")
    return new Response(markdown, { headers: { "content-type": "text/markdown" } })
  }

  async function retryLastPrompt(sessionId: SessionId): Promise<Response> {
    let bundle = state.getBundle(sessionId)
    if (bundle === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const runtime = getOrCreateRuntime(sessionId)

    // If a prompt is finalizing (running/persisting), wait for it to complete
    // before attempting retry. This is the architectural fix for the 409 race:
    // the error message and idle status are published before persistSession
    // finishes, so the TUI shows Retry while runningPrompt is still non-null.
    if (runtime.runningPrompt !== null) {
      await runtime.runningPrompt
      // Revalidate after the barrier: session may have been deleted or a
      // newer run may have started (queued prompt, goal continuation).
      if (state.getSession(sessionId) === undefined) {
        return notFound("session_not_found", `session not found: ${sessionId}`)
      }
      if (runtime.runningPrompt !== null) {
        return json(
          { error: "session_busy", message: "a newer run started while waiting for finalization" },
          409,
        )
      }
      // biome-ignore lint/style/noNonNullAssertion: checked above
      bundle = state.getBundle(sessionId)!
    }

    const lastUserMsg = [...bundle.messages].reverse().find((m) => m.role === "user")
    if (lastUserMsg === undefined) {
      return json({ error: "no_prompt", message: "no user prompt to retry" }, 400)
    }
    const promptText = lastUserMsg.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
    if (promptText.trim() === "") {
      return json({ error: "no_prompt", message: "last user message has no text" }, 400)
    }
    return await sendMessage(sessionId, { prompt: promptText, editMessageId: lastUserMsg.id })
  }

  async function getSubagentTranscript(sessionId: SessionId, agentId: string): Promise<Response> {
    if (state.getSession(sessionId) === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const factory = options?.engineFactory
    if (factory === undefined || typeof factory.getAgentTranscript !== "function") {
      return json(
        { error: "not_available", message: "subagent transcripts are not available" },
        501,
      )
    }
    const engineSessionId = engineSessionIds.get(sessionId)
    const result = await factory.getAgentTranscript(agentId, engineSessionId)
    if (result === null) {
      return notFound("subagent_not_found", `subagent transcript not found: ${agentId}`)
    }
    return json({ messages: result.messages })
  }

  function getContext(sessionId: SessionId): Response {
    const bundle = state.getBundle(sessionId)
    if (bundle === undefined)
      return notFound("session_not_found", `session not found: ${sessionId}`)
    const messages = bundle.messages
    const messageCount = messages.length
    const totalChars = messages.reduce(
      (sum, m) =>
        sum +
        m.parts
          .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
          .reduce((s, p) => s + p.text.length, 0),
      0,
    )
    return json({ messageCount, totalChars, estimatedTokens: Math.ceil(totalChars / 4) })
  }

  async function deleteSession(sessionId: SessionId): Promise<Response> {
    if (state.getSession(sessionId) === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const runtime = sessionRuntimes.get(sessionId)
    if (runtime !== undefined) {
      runtime.goalGeneration++
      runtime.engine.interrupt()
    }
    const goalSessionId = engineSessionIds.get(sessionId) ?? sessionId
    const goalEngine = await import("@wren/engine")
    if (goalEngine.clearGoal(goalSessionId)) {
      goalEngine.persistGoalClear(goalSessionId)
    }
    resolvePendingPermissions(sessionId, { behavior: "deny", message: "session deleted" })
    resolvePendingQuestions(sessionId)
    if (runtime !== undefined) {
      runtime.engine.dispose()
      sessionRuntimes.delete(sessionId)
    }
    for (const key of sessionAllowSet) {
      if (key.startsWith(`${sessionId}:`)) {
        sessionAllowSet.delete(key)
      }
    }
    try {
      await sessionStore.delete(sessionId)
    } catch {
      return json({ error: "delete_failed", message: "storage deletion failed" }, 500)
    }
    for (const [messageId, snapshot] of compactEditSnapshots) {
      if (snapshot.sessionId === sessionId) compactEditSnapshots.delete(messageId)
    }
    loadedMessageSessions.delete(sessionId)
    manualPlanSessions.delete(sessionId)
    loadingMessageSessions.delete(sessionId)
    pendingEngineSnapshots.delete(sessionId)
    engineSessionIds.delete(sessionId)
    for (const [mid] of userMessageEngineCounts) {
      if (mid.startsWith(`${sessionId}:`)) userMessageEngineCounts.delete(mid)
    }
    projectSessionDeletion(state, app, sessionId)
    return json({ ok: true })
  }

  function resolvePendingPermissions(sessionId: SessionId, outcome: PermissionOutcome): void {
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.sessionId !== sessionId) continue
      pendingPermissions.delete(requestId)
      dualState.resolvePermission(sessionId, requestId)
      pending.resolve(outcome)
    }
  }

  async function replyPermission(
    sessionId: SessionId,
    permId: string,
    body: unknown,
  ): Promise<Response> {
    if (state.getSession(sessionId) === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const pending = pendingPermissions.get(permId)
    if (pending === undefined || pending.sessionId !== sessionId) {
      return notFound("permission_not_found", `permission not found: ${permId}`)
    }
    const reply = parsePermissionReply(body)
    pendingPermissions.delete(permId)
    dualState.resolvePermission(sessionId, permId)
    if (reply === "deny") {
      pending.resolve({ behavior: "deny", message: "denied by user" })
    } else {
      if (reply === "session") {
        sessionAllowSet.add(sessionAllowKey(sessionId, pending.toolName))
      }
      pending.resolve({ behavior: "allow" })
    }
    return json({ ok: true })
  }

  function askUserQuestion(sessionId: SessionId, input: unknown): Promise<PermissionOutcome> {
    const runtime = getOrCreateRuntime(sessionId)
    if (runtime.aborted) {
      return Promise.resolve({ behavior: "deny", message: "session aborted" })
    }
    const inputRecord = input as {
      questions?: {
        question: string
        header: string
        options: { label: string }[]
        multiSelect?: boolean
      }[]
    }
    const questions = inputRecord.questions ?? []
    if (questions.length === 0) {
      return Promise.resolve({ behavior: "deny", message: "no questions provided" })
    }
    const questionIds = new Set<string>()
    const questionTextById = new Map<string, string>()
    const answers: Record<string, string> = {}

    for (const q of questions) {
      const qId = parseRequestId(`q_${randomUUID()}`)
      questionIds.add(qId)
      questionTextById.set(qId, q.question)
      dualState.setQuestion({
        id: qId,
        sessionId,
        title: q.question,
        detail: q.header,
        options: q.options.map((opt, idx) => ({ id: `opt_${idx}`, label: opt.label })),
        multiSelect: q.multiSelect === true,
      })
    }

    return new Promise<PermissionOutcome>((resolve) => {
      const group: PendingQuestionGroup = {
        sessionId,
        remaining: questionIds,
        answers,
        questionTextById,
        resolve: (collected) => {
          if (collected === null) {
            resolve({ behavior: "deny", message: "user declined to answer" })
            return
          }
          resolve({ behavior: "allow", updatedInput: { ...inputRecord, answers: collected } })
        },
      }
      for (const qId of questionIds) {
        pendingQuestions.set(qId, group)
      }
    })
  }

  async function replyQuestion(
    sessionId: SessionId,
    qId: string,
    body: unknown,
  ): Promise<Response> {
    if (state.getSession(sessionId) === undefined) {
      return notFound("session_not_found", `session not found: ${sessionId}`)
    }
    const group = pendingQuestions.get(qId)
    if (group === undefined || group.sessionId !== sessionId) {
      return notFound("question_not_found", `question not found: ${qId}`)
    }
    const reply = parseQuestionReply(body)
    pendingQuestions.delete(qId)
    dualState.resolveQuestion(sessionId, qId)
    group.remaining.delete(qId)

    if (reply.rejected) {
      for (const remainingId of group.remaining) {
        pendingQuestions.delete(remainingId)
        dualState.resolveQuestion(sessionId, remainingId)
      }
      group.remaining.clear()
      group.resolve(null)
      return json({ ok: true })
    }

    const questionText = group.questionTextById.get(qId)
    if (questionText !== undefined) {
      group.answers[questionText] = reply.answers.join(", ")
    }

    if (group.remaining.size === 0) {
      group.resolve(group.answers)
    }
    return json({ ok: true })
  }

  function resolvePendingQuestions(sessionId: SessionId): void {
    const seen = new Set<PendingQuestionGroup>()
    for (const [qId, group] of pendingQuestions) {
      if (group.sessionId !== sessionId) continue
      if (!seen.has(group)) {
        seen.add(group)
        for (const remainingId of group.remaining) {
          pendingQuestions.delete(remainingId)
          dualState.resolveQuestion(sessionId, remainingId)
        }
        group.remaining.clear()
        group.resolve(null)
      }
      pendingQuestions.delete(qId)
    }
  }

  function getConfig(): Response {
    const activeSession = getActiveSessionForResolver()
    const session = activeSession !== null ? state.getSession(activeSession) : undefined
    const registry = loadModelRegistry(adapterCwd)
    const providers = [...new Set(registry.entries.map((e) => e.ref.providerId))]
    const commands = (factory?.getCommands() ?? [])
      .filter((cmd) => !cmd.isHidden && (cmd.isEnabled?.() ?? true) && cmd.type !== "local-jsx")
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        loadedFrom: cmd.loadedFrom ?? "bundled",
        whenToUse: cmd.whenToUse,
      }))
    return json({
      model: getDefaultModel(),
      providers,
      permissionMode: session?.permissionMode ?? "default",
      agents: factory?.getAgents().map((a) => a.agentType) ?? [],
      diagnostics: registry.diagnostics,
      commands,
    })
  }

  async function setDefaultModel(body: unknown): Promise<Response> {
    const parsed = z
      .object({
        modelId: z.string().min(1),
        scope: z.literal("user"),
      })
      .safeParse(body)
    if (!parsed.success) {
      return json({ error: "invalid_body", message: parsed.error.message }, 400)
    }
    const { modelId, scope } = parsed.data
    const registry = loadModelRegistry(adapterCwd)
    const entry = registry.entries.find(
      (candidate) =>
        candidate.sourceName !== undefined &&
        `${candidate.sourceName}/${candidate.ref.modelId}` === modelId,
    )
    if (entry?.sourceName === undefined) {
      return json(
        { error: "unknown_model", message: `configured source model "${modelId}" not found` },
        400,
      )
    }
    const configPath = path.join(getWrenConfigHome(), "config.json")
    try {
      const existing = await readFile(configPath, "utf-8").catch(() => "{}")
      const config = JSON.parse(existing) as Record<string, unknown>
      config.defaultModel = { source: entry.sourceName, model: entry.ref.modelId }
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
      return json({ ok: true, modelId, scope })
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }

  async function resume(): Promise<void> {
    const list = await sessionStore.listSummaries(adapterCwd)
    for (const skipped of list.skipped) {
      console.error(`[wren] skipped corrupted session ${skipped.sessionId}: ${skipped.reason}`)
    }
    // list.bundles is ordered newest-first (DESC by time_updated). Reverse to
    // oldest-first so addSession appends maintain "oldest at index 0" — this
    // is what the home route's `slice(-3).reverse()` expects for recent runs.
    const bundles = list.bundles.slice().reverse()
    for (const bundle of bundles) {
      restoreBundle(bundle)
    }
    hasRestoredSessions = bundles.length > 0
    if (factory === undefined && bundles.length > 0) {
      const lastBundle = bundles[bundles.length - 1]
      if (lastBundle !== undefined) {
        engine.setModel(lastBundle.session.modelId)
      }
    }
  }

  function restoreBundle(bundle: SessionSummary): void {
    projectSessionCreation(state, app, bundle.session)
    const restored = bundle.session as Session & { title?: string }
    if (restored.title !== undefined && restored.title !== "") {
      setTitlesStore(bundle.session.id, restored.title)
    }
    const normalizedStatus: typeof bundle.status =
      bundle.status.type === "working" ||
      bundle.status.type === "retry" ||
      bundle.status.type === "compacting"
        ? { type: "idle" }
        : bundle.status
    projectStatus(state, app, bundle.session.id, normalizedStatus)
    if (bundle.preview !== undefined) {
      projectPreview(state, app, bundle.session.id, bundle.preview)
    }
    if (bundle.todos.length > 0) {
      projectTodos(state, app, bundle.session.id, bundle.todos)
    }
    if (bundle.diff.length > 0) {
      projectDiff(state, app, {
        sessionId: bundle.session.id,
        files: bundle.diff,
        updatedAt: clock.now(),
      })
    }
  }

  function rebuildEngineCounts(
    _sessionId: SessionId,
    tuiMessages: readonly Message[],
    engineMessages: readonly unknown[],
  ): void {
    const engineUuidToIndex = new Map<string, number>()
    for (let i = 0; i < engineMessages.length; i++) {
      const uuid = (engineMessages[i] as { uuid?: unknown })?.uuid
      if (typeof uuid === "string") {
        engineUuidToIndex.set(uuid, i)
      }
    }

    for (const m of tuiMessages) {
      if (m.role !== "user") continue
      if (!m.parts.some((p) => p.type === "text")) continue
      const engineCount = engineUuidToIndex.get(m.id)
      if (engineCount === undefined) continue
      userMessageEngineCounts.set(m.id, engineCount)
    }
  }

  function persistSession(sessionId: SessionId): Promise<void> {
    return serializedPersist(sessionId, async () => {
      const bundle = state.getBundle(sessionId)
      if (bundle === undefined) return
      const title = titlesStore[sessionId]
      const sessionToSave =
        title !== undefined && title !== "" ? { ...bundle.session, title } : bundle.session

      // If the session transcript hasn't been loaded from the database yet,
      // the in-memory bundle may have only a preview — a full save would
      // DELETE all messages and replace with only the preview. Fall back to
      // saveSessionMeta which only updates session-level fields without
      // touching messages. Once the transcript is loaded (loadedMessageSessions),
      // the in-memory state is authoritative — even if it has fewer messages
      // than the DB (e.g. after an edit/resend that truncated the old branch).
      if (!loadedMessageSessions.has(sessionId)) {
        await sessionStore.saveSessionMeta({
          session: sessionToSave,
          status: bundle.status,
          diff: bundle.diff,
        })
        return
      }

      await sessionStore.save({
        session: sessionToSave,
        status: bundle.status,
        messages: bundle.messages,
        todos: bundle.todos,
        permissions: bundle.permissions,
        diff: bundle.diff,
      })
    })
  }

  function persistSessionMeta(sessionId: SessionId): Promise<void> {
    return serializedPersist(sessionId, async () => {
      const bundle = state.getBundle(sessionId)
      if (bundle === undefined) return
      const title = titlesStore[sessionId]
      const sessionToSave =
        title !== undefined && title !== "" ? { ...bundle.session, title } : bundle.session
      await sessionStore.saveSessionMeta({
        session: sessionToSave,
        status: bundle.status,
        diff: bundle.diff,
      })
    })
  }

  function recordSystemMessage(sessionId: SessionId, text: string): Message["id"] {
    const messageId = parseMessageId(`msg_system_${randomUUID()}`)
    const message: Message = {
      id: messageId,
      sessionId,
      role: "system",
      parts: [{ type: "text", id: parsePartId(`part_system_${messageId}`), text }],
      createdAt: clock.now(),
    }
    projectMessageAddBeforeQueued(state, app, message)
    return messageId
  }

  function recordErrorAsMessage(sessionId: SessionId, text: string): void {
    const messageId = parseMessageId(`msg_err_${randomUUID()}`)
    const message: Message = {
      id: messageId,
      sessionId,
      role: "assistant",
      parts: [{ type: "text", id: parsePartId(`part_err_${messageId}`), text }],
      createdAt: clock.now(),
      error: text,
    }
    projectMessageAdd(state, app, message)
  }

  function recordUserPrompt(
    sessionId: SessionId,
    prompt: string,
    engineMessageCount: number,
    queued = false,
  ): Message["id"] {
    const messageId = parseMessageId(`msg_user_${randomUUID()}`)
    const message: Message = {
      id: messageId,
      sessionId,
      role: "user",
      parts: [{ type: "text", id: parsePartId(`part_text_${messageId}`), text: prompt }],
      createdAt: clock.now(),
      ...(queued && { queued: true }),
    }
    projectMessageAdd(state, app, message)
    userMessageEngineCounts.set(messageId, engineMessageCount)
    return messageId
  }

  function isCompactPrompt(prompt: string): boolean {
    return /^\/compact(?:\s|$)/.test(prompt.trim())
  }

  function selectedModelReference(
    modelId: string,
    effort: NonNullable<Session["effort"]>,
    sourceName?: string,
  ): SelectedModelReference | undefined {
    const slash = modelId.indexOf("/")
    const source = sourceName ?? (slash > 0 ? modelId.slice(0, slash) : undefined)
    const model =
      sourceName === undefined
        ? slash > 0
          ? modelId.slice(slash + 1)
          : undefined
        : modelId.slice(sourceName.length + 1)
    if (source === undefined || model === undefined || model === "") return undefined
    return { source, model, ...(effort !== "default" && { effort }) }
  }

  async function waitForIdle(sessionId: SessionId): Promise<void> {
    if (state.getSession(sessionId) === undefined) return
    const runtime = sessionRuntimes.get(sessionId)
    while (runtime?.runningPrompt !== null && runtime?.runningPrompt !== undefined) {
      await runtime.runningPrompt
    }
  }

  function getLastRunFailed(sessionId: SessionId): boolean {
    const runtime = sessionRuntimes.get(sessionId)
    return runtime?.lastRunFailed ?? false
  }

  return { fetch, resume, state, titles: () => titlesStore, waitForIdle, getLastRunFailed }
}

function sessionAllowKey(sessionId: SessionId, toolName: string): string {
  return `${sessionId}:${toolName}`
}

function isCcbToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_result",
  )
}

// Engine messages use SDK format: { type, message: { role, content }, uuid }.
// The fake engine in tests uses simplified format: { role, content }.
// Extract the inner message object so role/content checks work for both.
function engineMessageRecord(message: unknown): Record<string, unknown> | null {
  if (message === null || typeof message !== "object") return null
  const record = message as Record<string, unknown>
  const inner = record.message
  if (inner !== null && typeof inner === "object") {
    return inner as Record<string, unknown>
  }
  return record
}

function isEngineUserPrompt(message: unknown): boolean {
  const record = engineMessageRecord(message)
  if (record === null) return false
  return record.role === "user" && !isCcbToolResultContent(record.content)
}

export type { PermissionResolver, WrenEngine }

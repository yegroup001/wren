import type { UUID } from "node:crypto"
import { REPL_TOOL_NAME } from "src/tools/REPLTool/constants.js"
import type { EngineEvent, EngineEventInput } from "@wren/storage"
import type { Dirent } from "fs"
// Sync fs primitives for readFileTailSync — separate from fs/promises
// imports above. Named (not wildcard) per WREN.md style; no collisions
// with the async-suffixed names.
import { closeSync, fstatSync, openSync, readSync } from "fs"
import {
  appendFile as fsAppendFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "fs/promises"
import memoize from "lodash-es/memoize.js"
import { basename, dirname, join } from "path"

import {
  getOriginalCwd,
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  switchSession,
} from "../bootstrap/state.js"
import { builtInCommandNames } from "../commands.js"
import { COMMAND_NAME_TAG, TICK_TAG } from "../constants/xml.js"
import { getLocalFeatureValue } from "./featureGates.js"
import * as sessionIngress from "../services/api/sessionIngress.js"
import { getTranscriptStore } from "../storage/transcriptMirror.js"
import { type AgentId, asAgentId, asSessionId, type SessionId } from "../types/ids.js"
import type { AttributionSnapshotMessage } from "../types/logs.js"
import {
  type ContentReplacementEntry,
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type GoalState,
  type LogOption,
  type PersistedWorktreeSession,
  type SerializedMessage,
  sortLogs,
  type TranscriptMessage,
} from "../types/logs.js"
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from "../types/message.js"
import type { QueueOperationMessage } from "../types/messageQueueTypes.js"
import { uniq } from "./array.js"
import { registerCleanup } from "./cleanupRegistry.js"
import { updateSessionName } from "./concurrentSessions.js"
import { getCwd } from "./cwd.js"
import { logForDebugging } from "./debug.js"
import { logForDiagnosticsNoPII } from "./diagLogs.js"
import { getWrenConfigHomeDir, isEnvTruthy } from "./envUtils.js"
import { isFsInaccessible } from "./errors.js"
import type { FileHistorySnapshot } from "./fileHistory.js"
import { formatFileSize } from "./format.js"
import { getFsImplementation } from "./fsOperations.js"
import { getWorktreePaths } from "./getWorktreePaths.js"
import { getBranch } from "./git.js"
import { gracefulShutdownSync, isShuttingDown } from "./gracefulShutdown.js"
import { parseJSONL } from "./json.js"
import { logError } from "./log.js"
import { extractTag, isCompactBoundaryMessage } from "./messages.js"
import { sanitizePath } from "./path.js"
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from "./sessionStoragePortable.js"
import { getSettings_DEPRECATED } from "./settings/settings.js"
import { jsonParse, jsonStringify } from "./slowOperations.js"
import type { ContentReplacementRecord } from "./toolResultStorage.js"
import { validateUuid } from "./uuid.js"
import { VERSION } from "./buildInfo.js"

type Transcript = (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]

// Use getOriginalCwd() at each call site instead of capturing at module load
// time. getCwd() at import time may run before bootstrap resolves symlinks via
// realpathSync, causing a different sanitized project directory than what
// getOriginalCwd() returns after bootstrap. This split-brain made sessions
// saved under one path invisible when loaded via the other.

/**
 * Pre-compiled regex to skip non-meaningful messages when extracting first prompt.
 * Matches anything starting with a lowercase XML-like tag (IDE context, hook
 * output, task notifications, channel messages, etc.) or a synthetic interrupt
 * marker. Kept in sync with sessionStoragePortable.ts — generic pattern avoids
 * an ever-growing allowlist that falls behind as new notification types ship.
 */
// 50MB — prevents OOM in the tombstone slow path which reads + rewrites the
// entire session file. Session files can grow to multiple GB (inc-3930).
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

const SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/**
 * Type guard to check if an entry is a transcript message.
 * Transcript messages include user, assistant, attachment, and system messages.
 * IMPORTANT: This is the single source of truth for what constitutes a transcript message.
 * loadTranscriptFile() uses this to determine which messages to load into the chain.
 *
 * Progress messages are NOT transcript messages. They are ephemeral UI state
 * and must not be persisted to the JSONL or participate in the parentUuid
 * chain. Including them caused chain forks that orphaned real conversation
 * messages on resume (see #14373, #23537).
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === "user" ||
    entry.type === "assistant" ||
    entry.type === "attachment" ||
    entry.type === "system"
  )
}

/**
 * Entries that participate in the parentUuid chain. Used on the write path
 * (insertMessageChain, useLogMessages) to skip progress when assigning
 * parentUuid. Old transcripts with progress already in the chain are handled
 * by the progressBridge rewrite in loadTranscriptFile.
 */
export function isChainParticipant(m: Pick<Message, "type">): boolean {
  return m.type !== "progress"
}

type LegacyProgressEntry = {
  type: "progress"
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * Progress entries in transcripts written before PR #24099. They are not
 * in the Entry type union anymore but still exist on disk with uuid and
 * parentUuid fields. loadTranscriptFile bridges the chain across them.
 */
function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "type" in entry &&
    entry.type === "progress" &&
    "uuid" in entry &&
    typeof entry.uuid === "string"
  )
}

/**
 * High-frequency tool progress ticks (1/sec for Sleep, per-chunk for Bash).
 * These are UI-only: not sent to the API, not rendered after the tool
 * completes. Used by REPL.tsx to replace-in-place instead of appending, and
 * by loadTranscriptFile to skip legacy entries from old transcripts.
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  "bash_progress",
  "powershell_progress",
  "mcp_progress",
])
export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === "string" && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

// STORAGE NOTE — Wren's authoritative session store is SQLite
// (packages/storage → ~/.wren/sessions.db), written by the adapter
// (persistSession) and read for resume/session-list. The JSONL transcripts
// below are the vendored engine's full message stream: resume/history go
// through SQLite, but subagent transcript viewing (TUI → adapter
// /session/:id/subagent/:agentId → getAgentTranscript) and goal persistence
// (goalStorage writes/reads goal entries in the transcript) DO read JSONL,
// so it is not pure redundancy — it is the detail stream SQLite doesn't
// carry. A full migration would move subagent transcripts and goal state
// into SQLite before the JSONL path can be removed.

export function getProjectsDir(): string {
  return join(getWrenConfigHomeDir(), "projects")
}

export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  // When asking for the CURRENT session's transcript, honor sessionProjectDir
  // the same way getTranscriptPath() does. Without this, hooks get a
  // transcript_path computed from originalCwd while the actual file was
  // written to sessionProjectDir (set by switchActiveSession on resume/branch)
  // — different directories, so the hook sees MISSING (gh-30217). CC-34
  // made sessionId + sessionProjectDir atomic precisely to prevent this
  // kind of drift; this function just wasn't updated to read both.
  //
  // For OTHER session IDs we can only guess via originalCwd — we don't
  // track a sessionId→projectDir map. Callers wanting a specific other
  // session's path should pass fullPath explicitly (most save* functions
  // already accept this).
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

// 50 MB — session JSONL can grow to multiple GB (inc-3930). Callers that
// read the raw transcript must bail out above this threshold to avoid OOM.
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

// In-memory map of agentId → subdirectory for grouping related subagent
// transcripts (e.g. workflow runs write to subagents/workflows/<runId>/).
// Populated before the agent runs; consulted by getAgentTranscriptPath.
const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentTranscriptSubdirs.delete(agentId)
}

// Agent ids are used as a single filename segment below; anything with path
// separators or ".." could escape the transcript directory. This is the
// chokepoint for ALL transcript paths (adapter URL routes included).
export function isSafeAgentId(agentId: string): boolean {
  return agentId.length > 0 && agentId.length <= 128 && !/[/\\]|\.\./.test(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  if (!isSafeAgentId(agentId)) {
    throw new Error(`Invalid agentId: ${agentId}`)
  }
  // Same sessionProjectDir consistency as getTranscriptPathForSession —
  // subagent transcripts live under the session dir, so if the session
  // transcript is at sessionProjectDir, subagent transcripts are too.
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, "subagents", subdir)
    : join(projectDir, sessionId, "subagents")
  return join(base, `agent-${agentId}.jsonl`)
}

function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, ".meta.json")
}

export type AgentMetadata = {
  agentType: string
  /** Worktree path if the agent was spawned with isolation: "worktree" */
  worktreePath?: string
  /** Original task description from the AgentTool input. Persisted so a
   * resumed agent's notification can show the original description instead
   * of a placeholder. Optional — older metadata files lack this field. */
  description?: string
}

/**
 * Persist the agentType used to launch a subagent. Read by resume to
 * route correctly when subagent_type is omitted — without this, resuming
 * a fork silently degrades to general-purpose (4KB system prompt, no
 * inherited history). Sidecar file avoids JSONL schema changes.
 *
 * Also stores the worktreePath when the agent was spawned with worktree
 * isolation, enabling resume to restore the correct cwd.
 */
export async function writeAgentMetadata(agentId: AgentId, metadata: AgentMetadata): Promise<void> {
  // SQLite mirror is authoritative; the sidecar stays for pre-migration
  // readers (older processes fall back to it).
  const store = getTranscriptStore()
  if (store !== null) {
    const sessionId = getSessionId()
    void store
      .saveAgentMeta(sessionId, {
        agentId,
        sessionId,
        agentType: metadata.agentType,
        ...(metadata.worktreePath !== undefined && { worktreePath: metadata.worktreePath }),
        ...(metadata.description !== undefined && { description: metadata.description }),
      })
      .catch((error) => logError(error as Error))
  }
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(agentId: AgentId): Promise<AgentMetadata | null> {
  const store = getTranscriptStore()
  if (store !== null) {
    try {
      const meta = await store.agentMeta(agentId)
      if (meta !== undefined) {
        return {
          agentType: meta.agentType,
          ...(meta.worktreePath !== undefined && { worktreePath: meta.worktreePath }),
          ...(meta.description !== undefined && { description: meta.description }),
        }
      }
    } catch (error) {
      logError(error as Error)
    }
  }
  const path = getAgentMetadataPath(agentId)
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export type RemoteAgentMetadata = {
  taskId: string
  remoteTaskType: string
  /** CCR session ID — used to fetch live status from the Sessions API on resume. */
  sessionId: string
  title: string
  command: string
  spawnedAt: number
  toolUseId?: string
  isLongRunning?: boolean
  isUltraplan?: boolean
  isRemoteReview?: boolean
  remoteTaskMetadata?: Record<string, unknown>
}

function getRemoteAgentsDir(): string {
  // Same sessionProjectDir fallback as getAgentTranscriptPath — the project
  // dir (containing the .jsonl), not the session dir, so sessionId is joined.
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), "remote-agents")
}

function getRemoteAgentMetadataPath(taskId: string): string {
  return join(getRemoteAgentsDir(), `remote-agent-${taskId}.meta.json`)
}

/**
 * Persist metadata for a remote-agent task so it can be restored on session
 * resume. Per-task sidecar file (sibling dir to subagents/) survives
 * hydrateSessionFromRemote's .jsonl wipe; status is always fetched fresh
 * from CCR on restore — only identity is persisted locally.
 */
export async function writeRemoteAgentMetadata(
  taskId: string,
  metadata: RemoteAgentMetadata,
): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readRemoteAgentMetadata(taskId: string): Promise<RemoteAgentMetadata | null> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as RemoteAgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export async function deleteRemoteAgentMetadata(taskId: string): Promise<void> {
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    await unlink(path)
  } catch (e) {
    if (isFsInaccessible(e)) return
    throw e
  }
}

/**
 * Scan the remote-agents/ directory for all persisted metadata files.
 * Used by restoreRemoteAgentTasks to reconnect to still-running CCR sessions.
 */
export async function listRemoteAgentMetadata(): Promise<RemoteAgentMetadata[]> {
  const dir = getRemoteAgentsDir()
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }
  const results: RemoteAgentMetadata[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue
    try {
      const raw = await readFile(join(dir, entry.name), "utf-8")
      results.push(JSON.parse(raw) as RemoteAgentMetadata)
    } catch (e) {
      // Skip unreadable or corrupt files — a partial write from a crashed
      // fire-and-forget persist shouldn't take down the whole restore.
      logForDebugging(`listRemoteAgentMetadata: skipping ${entry.name}: ${String(e)}`)
    }
  }
  return results
}

export function sessionIdExists(sessionId: string): boolean {
  const store = getTranscriptStore()
  if (store !== null) {
    return store.sessionExists(sessionId)
  }
  // Legacy fallback: check JSONL file existence
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

// exported for testing
export function getNodeEnv(): string {
  return process.env.NODE_ENV || "development"
}

function getEntrypoint(): string | undefined {
  return process.env.WREN_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}

// Memoized: called 12+ times per turn via hooks.ts createBaseHookInput
// (PostToolUse path, 5×/turn) + various save* functions. Input is a cwd
// string; homedir/env/regex are all session-invariant so the result is
// stable for a given input. Worktree switches just change the key — no
// cache clear needed.
export const getProjectDir: (projectDir: string) => string = memoize((projectDir: string): string => {
  return join(getProjectsDir(), sanitizePath(projectDir))
})

let project: Project | null = null
let cleanupRegistered = false

function getProject(): Project {
  if (!project) {
    project = new Project()

    // Register flush as a cleanup handler (only once)
    if (!cleanupRegistered) {
      registerCleanup(async () => {
        // Flush queued writes first, then re-append session metadata
        // (customTitle, tag) so they always appear in the last 64KB tail
        // window. Tail reads only read the tail to extract these
        // fields — if enough messages are appended after a /rename, the
        // custom-title entry gets pushed outside the window and --resume
        // shows the auto-generated firstPrompt instead.
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch {
          // Best-effort — don't let metadata re-append crash the cleanup
        }
      })
      cleanupRegistered = true
    }
  }
  return project
}

/**
 * Reset the Project singleton's flush state for testing.
 * This ensures tests don't interfere with each other via shared counter state.
 */
export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

/** @internal Test-only append override. */
export function setAppendToFileForTesting(override: AppendToFileOverride | undefined): void {
  getProject().setAppendToFileForTesting(override)
}

/** @internal Test-only queue access. */
export function enqueueEntriesForTesting(filePath: string, entries: Entry[]): Promise<void>[] {
  return getProject().enqueueEntriesForTesting(filePath, entries)
}

/**
 * Reset the entire Project singleton for testing.
 * This ensures tests with different config home overrides
 * don't share stale sessionFile paths.
 */
export function resetProjectForTesting(): void {
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

type AppendToFileOverride = (filePath: string, data: string) => Promise<void>

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

/**
 * Register a CCR v2 internal event writer for transcript persistence.
 * When set, transcript messages are written as internal worker events
 * instead of going through v1 Session Ingress.
 */
export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

/**
 * Mirror hook for every transcript entry accepted for writing — messages,
 * metadata, goals, subagent sidechains, content replacements, ... Called
 * from enqueueWrite, the single chokepoint every persisted entry passes
 * through, with the context needed to route it into the SQLite transcript
 * store (the app wires mirrorEntryToSqlite here).
 */
export type EntryMirror = (
  entry: Entry,
  ctx: {
    sessionId: string
    agentId?: string
    isSidechain: boolean
    isCompaction: boolean
  },
) => void | Promise<void>

export function setEntryMirror(mirror: EntryMirror | undefined): void {
  getProject().entryMirror = mirror
}

/**
 * Override the on-disk JSONL writer (appendToFile). The app registers a
 * no-op sink once the SQLite transcript store is the storage of record,
 * keeping all in-memory dedup/chain logic intact while stopping file
 * growth. Pass null to restore the default fsAppendFile behavior.
 */
export function setTranscriptFileSink(
  sink: ((filePath: string, data: string) => Promise<void>) | null,
): void {
  getProject().setAppendToFileSink(sink)
}

/**
 * Mirror a transcript entry into the SQLite engine store (sessions.db).
 * Maps the JSONL entry 1:1 onto an engine_event: type = entry type, payload
 * = the full entry, messageUuid/parentUuid/timestamp/isCompact lifted for
 * the store's projection. Session state (custom-title, tag, goal, ...) is
 * derived automatically by the store's state projection.
 *
 * Message entries are deduped via hasMessage so a resumed process re-
 * recording its restored history doesn't duplicate rows. Registered by the
 * app with setEntryMirror; no-op when the store isn't initialized.
 */
// Serializes mirror writes: a burst of entries (e.g. one recordTranscript
// call re-recording restored history) must check hasMessage only after the
// previous entry's append committed, or the dedup race duplicates rows.
let mirrorChain: Promise<void> = Promise.resolve()

export function mirrorEntryToSqlite(
  entry: Entry,
  ctx: { sessionId: string; agentId?: string; isSidechain: boolean; isCompaction: boolean },
): void {
  const store = getTranscriptStore()
  if (store === null) return

  const run = async (): Promise<void> => {
    if (isTranscriptMessage(entry)) {
      if (await store.hasMessage(ctx.sessionId, entry.uuid)) return
      const event: EngineEventInput = {
        type: entry.type,
        payload: entry,
        messageUuid: entry.uuid,
        ...(entry.parentUuid !== undefined && entry.parentUuid !== null && {
          parentUuid: entry.parentUuid,
        }),
        ...(entry.timestamp !== undefined && { timestamp: entry.timestamp }),
        ...(ctx.isCompaction && { isCompact: true }),
      }
      await store.append(
        ctx.sessionId,
        getOriginalCwd(),
        {
          sessionId: ctx.sessionId,
          ...(ctx.isSidechain && ctx.agentId !== undefined && { agentId: ctx.agentId }),
          ...(ctx.isSidechain && { isSidechain: true }),
        },
        [event],
      )
      return
    }
    const event: EngineEventInput = {
      type: entry.type,
      payload: entry,
      ...(ctx.isCompaction && { isCompact: true }),
    }
    await store.append(
      ctx.sessionId,
      getOriginalCwd(),
      {
        sessionId: ctx.sessionId,
        ...(ctx.isSidechain && ctx.agentId !== undefined && { agentId: ctx.agentId }),
        ...(ctx.isSidechain && { isSidechain: true }),
      },
      [event],
    )
  }

  mirrorChain = mirrorChain.then(run).catch((error) => {
    logError(error as Error)
    logForDebugging("Failed to mirror transcript entry to SQLite")
  })
}

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

/**
 * Register a CCR v2 internal event reader for session resume.
 * When set, hydrateFromCCRv2InternalEvents() can fetch foreground and
 * subagent internal events to reconstruct conversation state on reconnection.
 */
export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  getProject().setInternalEventReader(reader)
  getProject().setInternalSubagentEventReader(subagentReader)
}

/**
 * Set the remote ingress URL on the current Project for testing.
 * This simulates what hydrateRemoteSession does in production.
 */
export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

const REMOTE_FLUSH_INTERVAL_MS = 10

// Limit the number of cached session-file lookups to prevent unbounded Map growth
// in long-running daemon / swarm sessions that spawn many sub-agents.
const MAX_CACHED_SESSION_FILES = 200

class Project {
  // Minimal cache for current session only (not all sessions)
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: "coordinator" | "normal" | undefined
  currentSessionGoal: GoalState | undefined
  // Tri-state: undefined = never touched (don't write), null = exited worktree,
  // object = currently in worktree. reAppendSessionMetadata writes null so
  // --resume knows the session exited (vs. crashed while inside).
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  // Entries buffered while sessionFile is null. Flushed by materializeSessionFile
  // on the first user/assistant message — prevents metadata-only session files.
  private pendingEntries: Entry[] = []
  private remoteIngressUrl: string | null = null
  private internalEventWriter: InternalEventWriter | null = null
  private internalEventReader: InternalEventReader | null = null
  private internalSubagentEventReader: InternalEventReader | null = null
  entryMirror: EntryMirror | undefined
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  // Per-file write queues. Each entry carries a resolve callback so
  // callers of enqueueWrite can optionally await their specific write.
  private writeQueues = new Map<string, Array<{ entry: Entry; resolve: () => void }>>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private appendToFileOverride: AppendToFileOverride | undefined
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024

  constructor() {}

  /** @internal Reset flush/queue state for testing. */
  _resetFlushState(): void {
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.activeDrain = null
    this.appendToFileOverride = undefined
    this.writeQueues = new Map()
    this.existingSessionFiles = new Map()
  }

  private incrementPendingWrites(): void {
    this.pendingWriteCount++
  }

  private decrementPendingWrites(): void {
    this.pendingWriteCount--
    if (this.pendingWriteCount === 0) {
      // Resolve all waiting flush promises
      for (const resolve of this.flushResolvers) {
        resolve()
      }
      this.flushResolvers = []
    }
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    if (this.entryMirror !== undefined) {
      const entryWithMeta = entry as {
        sessionId?: unknown
        isSidechain?: boolean
        agentId?: string
      }
      const agentId = entryWithMeta.agentId
      // Subagent content-replacement records carry agentId but no isSidechain
      // flag (appendEntry routes them to the agent file by agentId alone).
      const sidechainTarget = Boolean(
        agentId !== undefined && (entryWithMeta.isSidechain || entry.type === "content-replacement"),
      )
      void this.entryMirror(entry, {
        sessionId:
          typeof entryWithMeta.sessionId === "string" ? entryWithMeta.sessionId : getSessionId(),
        agentId,
        isSidechain: sidechainTarget,
        isCompaction: isCompactBoundaryMessage(entry as Message),
      })
    }
    return new Promise<void>((resolve) => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      // Drop oldest entries when queue exceeds limit to prevent unbounded memory growth
      if (queue.length >= 1000) {
        const dropped = queue.splice(0, queue.length - 999)
        for (const d of dropped) {
          d.resolve()
        }
      }
      queue.push({ entry, resolve })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.flushTimer || this.activeDrain) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.startDrain()
    }, this.FLUSH_INTERVAL_MS)
  }

  private startDrain(): Promise<void> {
    const drain = this.drainWriteQueue()
    this.activeDrain = drain
    void drain.then(
      () => this.finishDrain(drain),
      () => this.finishDrain(drain),
    )
    return drain
  }

  private finishDrain(drain: Promise<void>): void {
    if (this.activeDrain !== drain) {
      return
    }
    this.activeDrain = null
    if (this.writeQueues.size > 0) {
      this.scheduleDrain()
    }
  }

  setAppendToFileForTesting(override: AppendToFileOverride | undefined): void {
    this.appendToFileOverride = override
  }

  setAppendToFileSink(sink: ((filePath: string, data: string) => Promise<void>) | null): void {
    this.appendToFileOverride = sink ?? undefined
  }

  getAppendToFileSink(): ((filePath: string, data: string) => Promise<void>) | undefined {
    return this.appendToFileOverride
  }

  enqueueEntriesForTesting(filePath: string, entries: Entry[]): Promise<void>[] {
    return entries.map((entry) => this.enqueueWrite(filePath, entry))
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    if (this.appendToFileOverride) {
      await this.appendToFileOverride(filePath, data)
      return
    }
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      // Directory may not exist — some NFS-like filesystems return
      // unexpected error codes, so don't discriminate on code.
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      await fsAppendFile(filePath, data, { mode: 0o600 })
    }
  }

  private async drainWriteQueue(): Promise<void> {
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      let content = ""
      const resolvers: Array<() => void> = []

      for (const { entry, resolve } of batch) {
        const line = jsonStringify(entry) + "\n"

        if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
          // Flush chunk and resolve its entries before starting a new one
          await this.appendToFile(filePath, content)
          for (const r of resolvers) {
            r()
          }
          resolvers.length = 0
          content = ""
        }

        content += line
        resolvers.push(resolve)
      }

      if (content.length > 0) {
        await this.appendToFile(filePath, content)
        for (const r of resolvers) {
          r()
        }
      }
    }

    // Clean up empty queues
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.pendingEntries = []
  }

  /**
   * Re-append cached session metadata to the end of the transcript file.
   * This ensures metadata stays within the tail window that tail reads
   * scan during progressive loading.
   *
   * Called from two contexts with different file-ordering implications:
   * - During compaction (compact.ts, reactiveCompact.ts): writes metadata
   *   just before the boundary marker is emitted - these entries end up
   *   before the boundary and are recovered by scanPreBoundaryMetadata.
   * - On session exit (cleanup handler): writes metadata at EOF after all
   *   boundaries - this is what enables loadTranscriptFile's pre-compact
   *   skip to find metadata without a forward scan.
   *
   * External-writer safety for SDK-mutable fields (custom-title, tag):
   * before re-appending, refresh the cache from the tail scan window. If an
   * external process (SDK renameSession/tagSession) wrote a fresher value,
   * our stale cache absorbs it and the re-append below persists it — not
   * the stale CLI value. If no entry is in the tail (evicted, or never
   * written by the SDK), the cache is the only source of truth and is
   * re-appended as-is.
   *
   * Re-append is unconditional (even when the value is already in the
   * tail): during compaction, a title 40KB from EOF is inside the current
   * tail window but will fall out once the post-compaction session grows.
   * Skipping the re-append would defeat the purpose of this call. Fields
   * the SDK cannot touch (last-prompt, agent-*, mode, pr-link) have no
   * external-writer concern — their caches are authoritative.
   */
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    if (!this.sessionFile) return
    const sessionId = getSessionId() as UUID
    if (!sessionId) return

    // One sync tail read to refresh SDK-mutable fields. Same
    // LITE_READ_BUF_SIZE window used by tail reads. Empty string on
    // failure → extract returns null → cache is the only source of truth.
    const tail = readFileTailSync(this.sessionFile)

    // Absorb any fresher SDK-written title/tag into our cache. If the SDK
    // wrote while we had the session open, our cache is stale — the tail
    // value is authoritative. If the tail has nothing (evicted or never
    // written externally), the cache stands.
    //
    // Filter with startsWith to match only top-level JSONL entries (col 0)
    // and not "type":"tag" appearing inside a nested tool_use input that
    // happens to be JSON-serialized into a message.
    const tailLines = tail.split("\n")
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast((l) => l.startsWith('{"type":"custom-title"'))
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, "customTitle")
        // `!== undefined` distinguishes no-match from empty-string match.
        // renameSession rejects empty titles, but the CLI is defensive: an
        // external writer with customTitle:"" should clear the cache so the
        // re-append below skips it (instead of resurrecting a stale title).
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast((l) => l.startsWith('{"type":"tag"'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, "tag")
      // Same: tagSession(id, null) writes `tag:""` to clear.
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }

    // lastPrompt is re-appended so tail reads can show what the
    // user was most recently doing. Written first so customTitle/tag/etc
    // land closer to EOF (they're the more critical fields for tail reads).
    if (this.currentSessionLastPrompt) {
      appendEntryToFile(this.sessionFile, {
        type: "last-prompt",
        lastPrompt: this.currentSessionLastPrompt,
        sessionId,
      })
    }
    // Unconditional: cache was refreshed from tail above; re-append keeps
    // the entry at EOF so compaction-pushed content doesn't evict it.
    if (this.currentSessionTitle) {
      appendEntryToFile(this.sessionFile, {
        type: "custom-title",
        customTitle: this.currentSessionTitle,
        sessionId,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFile(this.sessionFile, {
        type: "tag",
        tag: this.currentSessionTag,
        sessionId,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFile(this.sessionFile, {
        type: "agent-name",
        agentName: this.currentSessionAgentName,
        sessionId,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFile(this.sessionFile, {
        type: "agent-color",
        agentColor: this.currentSessionAgentColor,
        sessionId,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFile(this.sessionFile, {
        type: "agent-setting",
        agentSetting: this.currentSessionAgentSetting,
        sessionId,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFile(this.sessionFile, {
        type: "mode",
        mode: this.currentSessionMode,
        sessionId,
      })
    }
    if (this.currentSessionGoal) {
      appendEntryToFile(this.sessionFile, {
        type: "goal",
        sessionId,
        state: this.currentSessionGoal,
        timestamp: new Date().toISOString(),
      })
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFile(this.sessionFile, {
        type: "worktree-state",
        worktreeSession: this.currentSessionWorktree,
        sessionId,
      })
    }
    if (
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
    ) {
      appendEntryToFile(this.sessionFile, {
        type: "pr-link",
        sessionId,
        prNumber: this.currentSessionPrNumber,
        prUrl: this.currentSessionPrUrl,
        prRepository: this.currentSessionPrRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async flush(): Promise<void> {
    // Drain and wait in a loop so a write arriving during an active drain is
    // handled by the same serialized path instead of starting a concurrent
    // direct drain here.
    while (true) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      if (this.activeDrain) {
        await this.activeDrain
        continue
      }
      if (this.writeQueues.size === 0) {
        break
      }
      await this.startDrain()
    }

    // Wait for non-queue tracked operations (e.g. removeMessageByUuid)
    if (this.pendingWriteCount === 0) {
      return
    }
    return new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * Remove a message from the transcript by UUID.
   * Used for tombstoning orphaned messages from failed streaming attempts.
   *
   * The target is almost always the most recently appended entry, so we
   * read only the tail, locate the line, and splice it out with a
   * positional write + truncate instead of rewriting the whole file.
   */
  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return this.trackWrite(async () => {
      if (this.sessionFile === null) return
      try {
        let fileSize = 0
        const fh = await fsOpen(this.sessionFile, "r+")
        try {
          const { size } = await fh.stat()
          fileSize = size
          if (size === 0) return

          const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
          const tailStart = size - chunkLen
          const buf = Buffer.allocUnsafe(chunkLen)
          const { bytesRead } = await fh.read(buf, 0, chunkLen, tailStart)
          const tail = buf.subarray(0, bytesRead)

          // Entries are serialized via JSON.stringify (no key-value
          // whitespace). Search for the full `"uuid":"..."` pattern, not
          // just the bare UUID, so we do not match the same value sitting
          // in `parentUuid` of a child entry. UUIDs are pure ASCII so a
          // byte-level search is correct.
          const needle = `"uuid":"${targetUuid}"`
          const matchIdx = tail.lastIndexOf(needle)

          if (matchIdx >= 0) {
            // 0x0a never appears inside a UTF-8 multi-byte sequence, so
            // byte-scanning for line boundaries is safe even if the chunk
            // starts mid-character.
            const prevNl = tail.lastIndexOf(0x0a, matchIdx)
            // If the preceding newline is outside our chunk and we did not
            // read from the start of the file, the line is longer than the
            // window - fall through to the slow path.
            if (prevNl >= 0 || tailStart === 0) {
              const lineStart = prevNl + 1 // 0 when prevNl === -1
              const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
              const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

              const absLineStart = tailStart + lineStart
              const afterLen = bytesRead - lineEnd
              // Truncate first, then re-append the trailing lines. In the
              // common case (target is the last entry) afterLen is 0 and
              // this is a single ftruncate.
              await fh.truncate(absLineStart)
              if (afterLen > 0) {
                await fh.write(tail, lineEnd, afterLen, absLineStart)
              }
              return
            }
          }
        } finally {
          await fh.close()
        }

        // Slow path: target was not in the last 64KB. Rare - requires many
        // large entries to have landed between the write and the tombstone.
        if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
          logForDebugging(
            `Skipping tombstone removal: session file too large (${formatFileSize(fileSize)})`,
            { level: "warn" },
          )
          return
        }
        const content = await readFile(this.sessionFile, { encoding: "utf-8" })
        const lines = content.split("\n").filter((line: string) => {
          if (!line.trim()) return true
          try {
            const entry = jsonParse(line)
            return entry.uuid !== targetUuid
          } catch {
            return true // Keep malformed lines
          }
        })
        await writeFile(this.sessionFile, lines.join("\n"), {
          encoding: "utf8",
        })
      } catch {
        // Silently ignore errors - the file might not exist yet
      }
    })
  }

  /**
   * True when test env / cleanupPeriodDays=0 / --no-session-persistence /
   * WREN_SKIP_PROMPT_HISTORY should suppress all transcript writes.
   * Shared guard for appendEntry and materializeSessionFile so both skip
   * consistently. The env var is set by tmuxSocket.ts so tmux-spawned
   * test sessions don't pollute the user's --resume list.
   */
  private shouldSkipPersistence(): boolean {
    const allowTestPersistence = isEnvTruthy(process.env.TEST_ENABLE_SESSION_PERSISTENCE)
    return (
      (getNodeEnv() === "test" && !allowTestPersistence) ||
      getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(process.env.WREN_SKIP_PROMPT_HISTORY)
    )
  }

  /**
   * Create the session file, write cached startup metadata, and flush
   * buffered entries. Called on the first user/assistant message.
   */
  private async materializeSessionFile(): Promise<void> {
    // Guard here too — reAppendSessionMetadata writes via appendEntryToFile
    // (not appendEntry) so it would bypass the per-entry persistence check
    // and create a metadata-only file despite --no-session-persistence.
    if (this.shouldSkipPersistence()) return
    this.ensureCurrentSessionFile()
    // mode/agentSetting are cache-only pre-materialization; write them now.
    this.reAppendSessionMetadata()
    if (this.pendingEntries.length > 0) {
      const buffered = this.pendingEntries
      this.pendingEntries = []
      for (const entry of buffered) {
        await this.appendEntry(entry)
      }
    }
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
  ) {
    return this.trackWrite(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null

      // First user/assistant message materializes the session file.
      // Hook progress/attachment messages alone stay buffered.
      if (
        this.sessionFile === null &&
        messages.some((m) => m.type === "user" || m.type === "assistant")
      ) {
        await this.materializeSessionFile()
      }

      // Get current git branch once for this message chain
      let gitBranch: string | undefined
      try {
        gitBranch = await getBranch()
      } catch {
        // Not in a git repo or git command failed
        gitBranch = undefined
      }

      // Get slug if one exists for this session (used for plan files, etc.)
      const sessionId = getSessionId()
      const slug = getPlanSlugCache().get(sessionId)

      for (const message of messages) {
        const isCompactBoundary = isCompactBoundaryMessage(message)

        // For tool_result messages, use the assistant message UUID from the message
        // if available (set at creation time), otherwise fall back to sequential parent
        let effectiveParentUuid = parentUuid
        if (
          message.type === "user" &&
          "sourceToolAssistantUUID" in message &&
          message.sourceToolAssistantUUID
        ) {
          effectiveParentUuid = message.sourceToolAssistantUUID as UUID
        }

        const transcriptMessage: TranscriptMessage = {
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
          isSidechain,
          teamName: teamInfo?.teamName,
          agentName: teamInfo?.agentName,
          promptId: message.type === "user" ? (getPromptId() ?? undefined) : undefined,
          agentId,
          ...message,
          // Session-stamp fields MUST come after the spread. On --fork-session
          // and --resume, messages arrive as SerializedMessage (carries source
          // sessionId/cwd/etc. because removeExtraFields only strips parentUuid
          // and isSidechain). If sessionId isn't re-stamped, FRESH.jsonl ends up
          // with messages stamped sessionId=A but content-replacement entries
          // stamped sessionId=FRESH (from insertContentReplacement), and
          // loadFullLog's sessionId-keyed contentReplacements lookup misses →
          // replacement records lost → FROZEN misclassification.
          userType: "external",
          entrypoint: getEntrypoint(),
          cwd: getCwd(),
          sessionId,
          timestamp: new Date().toISOString(),
          version: VERSION,
          gitBranch,
          slug,
        }
        await this.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          parentUuid = message.uuid
        }
      }

      // Cache this turn's user prompt for reAppendSessionMetadata —
      // the --resume picker shows what the user was last doing.
      // Overwritten every turn by design.
      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) {
          const flat = text.replace(/\n/g, " ").trim()
          this.currentSessionLastPrompt = flat.length > 200 ? flat.slice(0, 200).trim() + "…" : flat
        }
      }
    })
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    return this.trackWrite(async () => {
      const fileHistoryMessage: FileHistorySnapshotMessage = {
        type: "file-history-snapshot",
        messageId,
        snapshot,
        isSnapshotUpdate,
      }
      await this.appendEntry(fileHistoryMessage)
    })
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(queueOp)
    })
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(snapshot)
    })
  }

  async insertContentReplacement(replacements: ContentReplacementRecord[], agentId?: AgentId) {
    return this.trackWrite(async () => {
      const entry: ContentReplacementEntry = {
        type: "content-replacement",
        sessionId: getSessionId() as UUID,
        agentId,
        replacements,
      }
      await this.appendEntry(entry)
    })
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) {
      return
    }

    const currentSessionId = getSessionId() as UUID
    const isCurrentSession = sessionId === currentSessionId

    let sessionFile: string
    if (isCurrentSession) {
      // Buffer until materializeSessionFile runs (first user/assistant message).
      if (this.sessionFile === null) {
        this.pendingEntries.push(entry)
        return
      }
      sessionFile = this.sessionFile
    } else {
      const existing = await this.getExistingSessionFile(sessionId)
      if (!existing) {
        logError(new Error(`appendEntry: session file not found for other session ${sessionId}`))
        return
      }
      sessionFile = existing
    }

    // Only load current session messages if needed
    if (entry.type === "summary") {
      // Summaries can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "custom-title") {
      // Custom titles can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "ai-title") {
      // AI titles can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "last-prompt") {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "task-summary") {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "tag") {
      // Tags can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "agent-name") {
      // Agent names can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "agent-color") {
      // Agent colors can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "agent-setting") {
      // Agent settings can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "pr-link") {
      // PR links can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "file-history-snapshot") {
      // File history snapshots can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "attribution-snapshot") {
      // Attribution snapshots can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "speculation-accept") {
      // Speculation accept entries can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "mode") {
      // Mode entries can always be appended
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "worktree-state") {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "content-replacement") {
      // Content replacement records can always be appended. Subagent records
      // go to the sidechain file (for AgentTool resume); main-thread
      // records go to the session file (for /resume).
      const targetFile = entry.agentId ? getAgentTranscriptPath(entry.agentId) : sessionFile
      void this.enqueueWrite(targetFile, entry)
    } else if (entry.type === "marble-origami-commit") {
      // Always append. Commit order matters for restore (later commits may
      // reference earlier commits' summary messages), so these must be
      // written in the order received and read back sequentially.
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "marble-origami-snapshot") {
      // Always append. Last-wins on restore — later entries supersede.
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "goal") {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === "goal-cleared") {
      void this.enqueueWrite(sessionFile, entry)
    } else {
      const messageSet = await getSessionMessages(sessionId)
      if (entry.type === "queue-operation") {
        // Queue operations are always appended to the session file
        void this.enqueueWrite(sessionFile, entry)
      } else {
        // At this point, entry must be a TranscriptMessage (user/assistant/attachment/system)
        // All other entry types have been handled above
        const isAgentSidechain = entry.isSidechain && entry.agentId !== undefined
        const targetFile = isAgentSidechain
          ? getAgentTranscriptPath(asAgentId(entry.agentId!))
          : sessionFile

        // For message entries, check if UUID already exists in current session.
        // Skip dedup for agent sidechain LOCAL writes — they go to a separate
        // file, and fork-inherited parent messages share UUIDs with the main
        // session transcript. Deduping against the main session's set would
        // drop them, leaving the persisted sidechain transcript incomplete
        // (resume-of-fork loads a 10KB file instead of the full 85KB inherited
        // context).
        //
        // The sidechain bypass applies ONLY to the local file write — remote
        // persistence (session-ingress) uses a single Last-Uuid chain per
        // sessionId, so re-POSTing a UUID it already has 409s and eventually
        // exhausts retries → gracefulShutdownSync(1). See inc-4718.
        const isNewUuid = !messageSet.has(entry.uuid)
        if (isAgentSidechain || isNewUuid) {
          // Enqueue write — appendToFile handles ENOENT by creating directories
          void this.enqueueWrite(targetFile, entry)

          if (!isAgentSidechain) {
            // messageSet is main-file-authoritative. Sidechain entries go to a
            // separate agent file — adding their UUIDs here causes recordTranscript
            // to skip them on the main thread (line ~1270), so the message is never
            // written to the main session file. The next main-thread message then
            // chains its parentUuid to a UUID that only exists in the agent file,
            // and --resume's buildConversationChain terminates at the dangling ref.
            // Same constraint for remote (inc-4718 above): sidechain persisting a
            // UUID the main thread hasn't written yet → 409 when main writes it.
            messageSet.add(entry.uuid)

            if (isTranscriptMessage(entry)) {
              await this.persistToRemote(sessionId, entry)
            }
          }
        }
      }
    }
  }

  /**
   * Loads the sessionFile variable.
   * Do not need to create session files until they are written to.
   */
  private ensureCurrentSessionFile(): string {
    if (this.sessionFile === null) {
      this.sessionFile = getTranscriptPath()
    }

    return this.sessionFile
  }

  /**
   * Returns the session file path if it exists, null otherwise.
   * Used for writing to sessions other than the current one.
   * Caches positive results so we only stat once per session.
   *
   * The cache is bounded at MAX_CACHED_SESSION_FILES to prevent unbounded
   * growth in long-running daemon / swarm sessions that spawn many agents.
   */
  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(sessionId: UUID): Promise<string | null> {
    const cached = this.existingSessionFiles.get(sessionId)
    if (cached) return cached

    const targetFile = getTranscriptPathForSession(sessionId)
    try {
      await stat(targetFile)
      // Evict oldest entry when at capacity so the Map stays bounded
      if (this.existingSessionFiles.size >= MAX_CACHED_SESSION_FILES) {
        const oldestKey = this.existingSessionFiles.keys().next().value
        if (oldestKey !== undefined) {
          this.existingSessionFiles.delete(oldestKey)
        }
      }
      this.existingSessionFiles.set(sessionId, targetFile)
      return targetFile
    } catch (e) {
      if (isFsInaccessible(e)) return null
      throw e
    }
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    if (isShuttingDown()) {
      return
    }

    // CCR v2 path: write as internal worker event
    if (this.internalEventWriter) {
      try {
        await this.internalEventWriter("transcript", entry as unknown as Record<string, unknown>, {
          ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
          ...(entry.agentId && { agentId: entry.agentId }),
        })
      } catch {

        logForDebugging("Failed to write transcript as internal event")
      }
      return
    }

    // v1 Session Ingress path
    if (!isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE) || !this.remoteIngressUrl) {
      return
    }

    const success = await sessionIngress.appendSessionLog(sessionId, entry, this.remoteIngressUrl)

    if (!success) {

      gracefulShutdownSync(1, "other")
    }
  }

  setRemoteIngressUrl(url: string): void {
    this.remoteIngressUrl = url
    logForDebugging(`Remote persistence enabled with URL: ${url}`)
    if (url) {
      // If using CCR, don't delay messages by any more than 10ms.
      this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
    }
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    this.internalEventWriter = writer
    logForDebugging("CCR v2 internal event writer registered for transcript persistence")
    // Use fast flush interval for CCR v2
    this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    this.internalEventReader = reader
    logForDebugging("CCR v2 internal event reader registered for session resume")
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    this.internalSubagentEventReader = reader
    logForDebugging("CCR v2 subagent event reader registered for session resume")
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.internalEventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.internalSubagentEventReader
  }
}

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

// Filter out already-recorded messages before passing to insertMessageChain.
// Without this, after compaction messagesToKeep (same UUIDs as pre-compact
// messages) are dedup-skipped by appendEntry but still advance the parentUuid
// cursor in insertMessageChain, causing new messages to chain from pre-compact
// UUIDs instead of the post-compact summary — orphaning the compact boundary.
//
// `startingParentUuidHint`: used by useLogMessages to pass the parent from
// the previous incremental slice, avoiding an O(n) scan to rediscover it.
//
// Skip-tracking: already-recorded messages are tracked as the parent ONLY if
// they form a PREFIX (appear before any new message). This handles both cases:
//  - Growing-array callers (QueryEngine, queryHelpers, LocalMainSessionTask,
//    trajectory): recorded messages are always a prefix → tracked → correct
//    parent chain for new messages.
//  - Compaction (useLogMessages): new CB/summary appear FIRST, then recorded
//    messagesToKeep → not a prefix → not tracked → CB gets parentUuid=null
//    (correct: truncates --continue chain at compact boundary).
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  // Dedup: check each message uuid individually via the indexed hasMessage
  // query instead of loading the entire session's message set. For the common
  // case (1-5 new messages after a turn), this is 1-5 O(1) index lookups vs
  // one O(n) full-table scan that JSON-parses every payload.
  //
  // The shared cache Set is still populated so appendEntry's in-memory dedup
  // continues to work within the same turn.
  const messageSet = await getSessionMessages(sessionId)
  const store = getTranscriptStore()
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    const uuid = m.uuid as UUID
    const exists = messageSet.has(uuid) || (store !== null && await store.hasMessage(sessionId, uuid))
    if (exists) {
      // Only track skipped messages that form a prefix. After compaction,
      // messagesToKeep appear AFTER new CB/summary, so this skips them.
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = uuid
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }
  // Return the last ACTUALLY recorded chain-participant's UUID, OR the
  // prefix-tracked UUID if no new chain participants were recorded. This lets
  // callers (useLogMessages) maintain the correct parent chain even when the
  // slice is all-recorded (rewind, /resume scenarios where every message is
  // already in messageSet). Progress is skipped — it's written to the JSONL
  // but nothing chains TO it (see isChainParticipant).
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

/**
 * Remove a message from the transcript by UUID.
 * Used when a tombstone is received for an orphaned message.
 */
export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(messageId, snapshot, isSnapshotUpdate)
}

export async function recordAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
) {
  await getProject().insertContentReplacement(replacements, agentId)
}

/**
 * Reset the session file pointer after switchSession/regenerateSessionId.
 * The new file is created lazily on the first user/assistant message.
 */
export async function resetSessionFilePointer() {
  getProject().resetSessionFile()
}

/**
 * Adopt the existing session file after --continue/--resume (non-fork).
 * Call after switchSession + resetSessionFilePointer + restoreSessionMetadata:
 * getTranscriptPath() now derives the resumed file's path from the switched
 * sessionId, and the cache holds the final metadata (--name title, resumed
 * mode/tag/agent).
 *
 * Setting sessionFile here — instead of waiting for materializeSessionFile
 * on the first user message — lets the exit cleanup handler's
 * reAppendSessionMetadata run (it bails when sessionFile is null). Without
 * this, `-c -n foo` + quit-before-message drops the title on the floor:
 * the in-memory cache is correct but never written. The resumed file
 * already exists on disk (we loaded from it), so this can't create an
 * orphan the way a fresh --name session would.
 *
 * skipTitleRefresh: restoreSessionMetadata populated the cache from the
 * same disk read microseconds ago, so refreshing from the tail here is a
 * no-op — unless --name was used, in which case it would clobber the fresh
 * CLI title with the stale disk value. After this write, disk == cache and
 * later calls (compaction, exit cleanup) absorb SDK writes normally.
 */
export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
}

/**
 * Append a context-collapse commit entry to the transcript. One entry per
 * commit, in commit order. On resume these are collected into an ordered
 * array and handed to restoreFromEntries() which rebuilds the commit log.
 */
export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: "marble-origami-commit",
    sessionId,
    ...commit,
  })
}

/**
 * Snapshot the staged queue + spawn state. Written after each ctx-agent
 * spawn resolves (when staged contents may have changed). Last-wins on
 * restore — the loader keeps only the most recent snapshot entry.
 */
export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: "marble-origami-snapshot",
    sessionId,
    ...snapshot,
  })
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

export async function hydrateRemoteSession(
  sessionId: string,
  ingressUrl: string,
): Promise<boolean> {
  switchSession(asSessionId(sessionId))

  const project = getProject()

  try {
    const remoteLogs = (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) || []

    // Ensure the project directory and session file exist
    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    const sessionFile = getTranscriptPathForSession(sessionId)

    // Replace local logs with remote logs. writeFile truncates, so no
    // unlink is needed; an empty remoteLogs array produces an empty file.
    const content = remoteLogs.map((e) => jsonStringify(e) + "\n").join("")
    await writeFile(sessionFile, content, { encoding: "utf8", mode: 0o600 })

    logForDebugging(`Hydrated ${remoteLogs.length} entries from remote`)
    return remoteLogs.length > 0
  } catch (error) {
    logForDebugging(`Error hydrating session from remote: ${error}`)
    logForDiagnosticsNoPII("error", "hydrate_remote_session_fail")
    return false
  } finally {
    // Set remote ingress URL after hydrating the remote session
    // to ensure we've always synced with the remote session
    // prior to enabling persistence
    project.setRemoteIngressUrl(ingressUrl)
  }
}

/**
 * Hydrate session state from CCR v2 internal events.
 * Fetches foreground and subagent events via the registered readers,
 * extracts transcript entries from payloads, and writes them to the
 * local transcript files (main + per-agent).
 * The server handles compaction filtering — it returns events starting
 * from the latest compaction boundary.
 */
export async function hydrateFromCCRv2InternalEvents(sessionId: string): Promise<boolean> {
  const startMs = Date.now()
  switchSession(asSessionId(sessionId))

  const project = getProject()
  const reader = project.getInternalEventReader()
  if (!reader) {
    logForDebugging("No internal event reader registered for CCR v2 resume")
    return false
  }

  try {
    // Fetch foreground events
    const events = await reader()
    if (!events) {
      logForDebugging("Failed to read internal events for resume")
      logForDiagnosticsNoPII("error", "hydrate_ccr_v2_read_fail")
      return false
    }

    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    // Write foreground transcript
    const sessionFile = getTranscriptPathForSession(sessionId)
    const fgContent = events.map((e) => jsonStringify(e.payload) + "\n").join("")
    await writeFile(sessionFile, fgContent, { encoding: "utf8", mode: 0o600 })

    logForDebugging(`Hydrated ${events.length} foreground entries from CCR v2 internal events`)

    // Fetch and write subagent events
    let subagentEventCount = 0
    const subagentReader = project.getInternalSubagentEventReader()
    if (subagentReader) {
      const subagentEvents = await subagentReader()
      if (subagentEvents && subagentEvents.length > 0) {
        subagentEventCount = subagentEvents.length
        // Group by agent_id
        const byAgent = new Map<string, Record<string, unknown>[]>()
        for (const e of subagentEvents) {
          const agentId = e.agent_id || ""
          if (!agentId) continue
          let list = byAgent.get(agentId)
          if (!list) {
            list = []
            byAgent.set(agentId, list)
          }
          list.push(e.payload)
        }

        // Write each agent's transcript to its own file
        for (const [agentId, entries] of byAgent) {
          const agentFile = getAgentTranscriptPath(asAgentId(agentId))
          await mkdir(dirname(agentFile), { recursive: true, mode: 0o700 })
          const agentContent = entries.map((p) => jsonStringify(p) + "\n").join("")
          await writeFile(agentFile, agentContent, {
            encoding: "utf8",
            mode: 0o600,
          })
        }

        logForDebugging(
          `Hydrated ${subagentEvents.length} subagent entries across ${byAgent.size} agents`,
        )
      }
    }

    logForDiagnosticsNoPII("info", "hydrate_ccr_v2_completed", {
      duration_ms: Date.now() - startMs,
      event_count: events.length,
      subagent_event_count: subagentEventCount,
    })
    return events.length > 0
  } catch (error) {
    // Re-throw epoch mismatch so the worker doesn't race against gracefulShutdown
    if (error instanceof Error && error.message === "CCRClient: Epoch mismatch (409)") {
      throw error
    }
    logForDebugging(`Error hydrating session from CCR v2: ${error}`)
    logForDiagnosticsNoPII("error", "hydrate_ccr_v2_fail")
    return false
  }
}

function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, " ").trim()

    // Store a reasonably long version for display-time truncation
    // The actual truncation will be applied at display time based on terminal width
    if (result.length > 200) {
      result = result.slice(0, 200).trim() + "…"
    }

    return result
  }

  return "No prompt"
}

/**
 * Gets the last user message that was processed (i.e., before any non-user message appears).
 * Used to determine if a session has valid user interaction.
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== "user" || msg.isMeta) continue
    // Skip compact summary messages - they should not be treated as the first prompt
    if ("isCompactSummary" in msg && msg.isCompactSummary) continue

    const content = msg.message?.content
    if (!content) continue

    // Collect all text values. For array content (common in VS Code where
    // IDE metadata tags come before the user's actual prompt), iterate all
    // text blocks so we don't miss the real prompt hidden behind
    // <ide_selection>/<ide_opened_file> blocks.
    const texts: string[] = []
    if (typeof content === "string") {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) continue

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, "")

        // If it's a built-in command, then it's unlikely to provide
        // meaningful context (e.g. `/model sonnet`)
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // Otherwise, for custom commands, then keep it only if it has
          // arguments (e.g. `/review reticulate splines`)
          const commandArgs = extractTag(textContent, "command-args")?.trim()
          if (!commandArgs) {
            continue
          }
          // Return clean formatted command instead of raw XML
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // Format bash input with ! prefix (as user typed it). Checked before
      // the generic XML skip so bash-mode sessions get a meaningful title.
      const bashInput = extractTag(textContent, "bash-input")
      if (bashInput) {
        return `! ${bashInput}`
      }

      // Skip non-meaningful messages (local command output, hook output,
      // autonomous tick prompts, task notifications, pure IDE metadata tags)
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(transcript: TranscriptMessage[]): SerializedMessage[] {
  return transcript.map((m) => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

/**
 * Splice the preserved segment back into the chain after compaction.
 *
 * Preserved messages exist in the JSONL with their ORIGINAL pre-compact
 * parentUuids (recordTranscript dedup-skipped them — can't rewrite).
 * The internal chain (keep[i+1]→keep[i]) is intact; only endpoints need
 * patching: head→anchor, and anchor's other children→tail. Anchor is the
 * last summary for suffix-preserving, boundary itself for prefix-preserving.
 *
 * Only the LAST seg-boundary is relinked — earlier segs were summarized
 * into it. Everything physically before the absolute-last boundary (except
 * preservedUuids) is deleted, which handles all multi-boundary shapes
 * without special-casing.
 *
 * Mutates the Map in place.
 */
function applyPreservedSegmentRelinks(messages: Map<UUID, TranscriptMessage>): void {
  type Seg = NonNullable<SystemCompactBoundaryMessage["compactMetadata"]["preservedSegment"]>

  // Find the absolute-last boundary and the last seg-boundary (can differ:
  // manual /compact after reactive compact → seg is stale).
  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // No seg anywhere → no-op. findUnresolvedToolUse etc. read the full map.
  if (!lastSeg) return

  // Seg stale (no-seg boundary came after): skip relink, still prune at
  // absolute — otherwise the stale preserved chain becomes a phantom leaf.
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // Validate tail→head BEFORE mutating so malformed metadata is a true
  // no-op (walk stops at headUuid, doesn't need the relink to run first).
  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      // tail→head walk broke — a UUID in the preserved segment isn't in the
      // transcript. Returning here skips the prune below, so resume loads
      // the full pre-compact history. Known cause: mid-turn-yielded
      // attachment pushed to mutableMessages but never recordTranscript'd
      // (SDK subprocess restarted before next turn's qe:420 flush).

      return
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    // Tail-splice: anchor's other children → tail. No-op if already pointing
    // at tail (the useLogMessages race case).
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    // Zero stale usage: on-disk input_tokens reflect pre-compact context
    // (~190K) — stripStaleUsage only patched in-memory copies that were
    // dedup-skipped. Without this, resume → immediate autocompact spiral.
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== "assistant") continue
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message!,
          usage: {
            ...msg.message!.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  // Prune everything physically before the absolute-last boundary that
  // isn't preserved. preservedUuids empty when !segIsLive → full prune.
  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (idx !== undefined && idx < absoluteLastBoundaryIdx && !preservedUuids.has(uuid)) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) messages.delete(uuid)
}

/**
 * Delete messages that Snip executions removed from the in-memory array,
 * and relink parentUuid across the gaps.
 *
 * Unlike compact_boundary which truncates a prefix, snip removes
 * middle ranges. The JSONL is append-only, so removed messages stay on disk
 * and the surviving messages' parentUuid chains walk through them. Without
 * this filter, buildConversationChain reconstructs the full unsnipped history
 * and resume immediately PTLs (adamr-20260320-165831: 397K displayed → 1.65M
 * actual).
 *
 * Deleting alone is not enough: the surviving message AFTER a removed range
 * has parentUuid pointing INTO the gap. buildConversationChain would hit
 * messages.get(undefined) and stop, orphaning everything before the gap. So
 * after delete we relink: for each survivor with a dangling parentUuid, walk
 * backward through the removed region's own parent links to the first
 * non-removed ancestor.
 *
 * The boundary records removedUuids at execution time so we can replay the
 * exact removal on load. Older boundaries without removedUuids are skipped —
 * resume loads their pre-snip history (the pre-fix behavior).
 *
 * Mutates the Map in place.
 */
function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  // Structural check — snipMetadata only exists on the boundary subtype.
  // Avoids the subtype literal which is in excluded-strings.txt
  // (HISTORY_SNIP is legacy; the literal must not leak into external builds).
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) continue
    for (const uuid of removedUuids) toDelete.add(uuid)
  }
  if (toDelete.size === 0) return

  // Capture each to-delete entry's own parentUuid BEFORE deleting so we can
  // walk backward through contiguous removed ranges. Entries not in the Map
  // (already absent, e.g. from a prior compact_boundary prune) contribute no
  // link; the relink walk will stop at the gap and pick up null (chain-root
  // behavior — same as if compact truncated there, which it did).
  const deletedParent = new Map<UUID, UUID | null>()
  let removedCount = 0
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) continue
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
    removedCount++
  }

  // Relink survivors with dangling parentUuid. Walk backward through
  // deletedParent until we hit a UUID not in toDelete (or null). Path
  // compression: after resolving, seed the map with the resolved link so
  // subsequent survivors sharing the same chain segment don't re-walk.
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) deletedParent.set(p, cur)
    return cur
  }
  let relinkedCount = 0
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
    relinkedCount++
  }


}

/**
 * O(n) single-pass: find the message with the latest timestamp matching a predicate.
 * Replaces the `[...values].filter(pred).sort((a,b) => Date(b)-Date(a))[0]` pattern
 * which is O(n log n) + 2n Date allocations.
 */
function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * Builds a conversation chain from a leaf message to root
 * @param messages Map of all messages
 * @param leafMessage The leaf message to start from
 * @returns Array of messages from root to leaf
 */
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )

      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid ? messages.get(currentMsg.parentUuid) : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}

/**
 * Post-pass for buildConversationChain: recover sibling assistant blocks and
 * tool_results that the single-parent walk orphaned.
 *
 * Streaming (claude.ts:~2024) emits one AssistantMessage per content_block_stop
 * — N parallel tool_uses → N messages, distinct uuid, same message.id. Each
 * tool_result's sourceToolAssistantUUID points to its own one-block assistant,
 * so insertMessageChain's override (line ~894) writes each TR's parentUuid to a
 * DIFFERENT assistant. The topology is a DAG; the walk above is a linked-list
 * traversal and keeps only one branch.
 *
 * Two loss modes observed in production (both fixed here):
 *   1. Sibling assistant orphaned: walk goes prev→asstA→TR_A→next, drops asstB
 *      (same message.id, chained off asstA) and TR_B.
 *   2. Progress-fork (legacy, pre-#23537): each tool_use asst had a progress
 *      child (continued the write chain) AND a TR child. Walk followed
 *      progress; TRs were dropped. No longer written (progress removed from
 *      transcript persistence), but old transcripts still have this shape.
 *
 * Read-side fix: the write topology is already on disk for old transcripts;
 * this recovery pass handles them.
 */
function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = TranscriptMessage & { type: "assistant" }
  const chainAssistants = chain.filter((m): m is ChainAssistant => m.type === "assistant")
  if (chainAssistants.length === 0) return chain

  // Anchor = last on-chain member of each sibling group. chainAssistants is
  // already in chain order, so later iterations overwrite → last wins.
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message!.id) anchorByMsgId.set(a.message!.id, a)
  }

  // O(n) precompute: sibling groups and TR index.
  // TRs indexed by parentUuid — insertMessageChain:~894 already wrote that
  // as the srcUUID, and --fork-session strips srcUUID but keeps parentUuid.
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === "assistant" && m.message!.id) {
      const group = siblingsByMsgId.get(m.message!.id)
      if (group) group.push(m)
      else siblingsByMsgId.set(m.message!.id, [m])
    } else if (
      m.type === "user" &&
      m.parentUuid &&
      Array.isArray(m.message!.content) &&
      (m.message!.content as Array<{ type: string }>).some((b) => b.type === "tool_result")
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) group.push(m)
      else toolResultsByAsst.set(m.parentUuid, [m])
    }
  }

  // For each message.id group touching the chain: collect off-chain siblings,
  // then off-chain TRs for ALL members. Splice right after the last on-chain
  // member so the group stays contiguous for normalizeMessagesForAPI's merge
  // and every TR lands after its tool_use.
  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message!.id
    if (!msgId || processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter((s) => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) continue
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) orphanedTRs.push(tr)
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue

    // Timestamp sort keeps content-block / completion order; stable-sort
    // preserves JSONL write order on ties.
    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) seen.add(r.uuid)
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) return chain


  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return result
}

/**
 * Find the latest turn_duration checkpoint in the reconstructed chain and
 * compare its recorded messageCount against the chain's position at that
 * point. Emits wren_resume_consistency_delta for BigQuery monitoring of
 * write→load round-trip drift — the class of bugs where snip/compact/
 * parallel-TR operations mutate in-memory but the parentUuid walk on disk
 * reconstructs a different set (adamr-20260320-165831: 397K displayed →
 * 1.65M actual on resume).
 *
 * delta > 0: resume loaded MORE than in-session (the usual failure mode)
 * delta < 0: resume loaded FEWER (chain truncation — #22453 class)
 * delta = 0: round-trip consistent
 *
 * Called from loadConversationForResume — fires once per resume, not on
 * log-listing chain rebuilds.
 */
export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== "system" || m.subtype !== "turn_duration") continue
    const expected = m.messageCount as number | undefined
    if (expected === undefined) return
    // `i` is the 0-based index of the checkpoint in the reconstructed chain.
    // The checkpoint was appended AFTER messageCount messages, so its own
    // position should be messageCount (i.e., i === expected).
    const actual = i

    return
  }
}

/**
 * Builds a filie history snapshot chain from the conversation
 */
function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → last index in snapshots[] for O(1) update lookup
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate ? indexByMessageId.get(snapshot.messageId) : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * Builds an attribution snapshot chain from the conversation.
 * Unlike file history snapshots, attribution snapshots are returned in full
 * because they use generated UUIDs (not message UUIDs) and represent
 * cumulative state that should be restored on session resume.
 */
function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // Return all attribution snapshots - they will be merged during restore
  return Array.from(attributionSnapshots.values())
}


/**
 * Checks if a user message has visible content (text or image, not just tool_result).
 * Tool results are displayed as part of collapsed groups, not as standalone messages.
 * Also excludes meta messages which are not shown to the user.
 */
function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== "user") return false

  // Meta messages are not shown to the user
  if (message.isMeta) return false

  const content = message.message?.content
  if (!content) return false

  // String content is always visible
  if (typeof content === "string") {
    return content.trim().length > 0
  }

  // Array content: check for text or image blocks (not tool_result)
  if (Array.isArray(content)) {
    return content.some(
      (block) => block.type === "text" || block.type === "image" || block.type === "document",
    )
  }

  return false
}

/**
 * Checks if an assistant message has visible text content (not just tool_use blocks).
 * Tool uses are displayed as grouped/collapsed UI elements, not as standalone messages.
 */
function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== "assistant") return false

  const content = message.message?.content
  if (!content || !Array.isArray(content)) return false

  // Check for text block (not just tool_use/thinking blocks)
  return content.some(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  )
}

/**
 * Counts visible messages that would appear as conversation turns in the UI.
 * Excludes:
 * - System, attachment, and progress messages
 * - User messages with isMeta flag (hidden from user)
 * - User messages that only contain tool_result blocks (displayed as collapsed groups)
 * - Assistant messages that only contain tool_use blocks (displayed as collapsed groups)
 */
function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case "user":
        // Count user messages with visible content (text, image, not just tool_result or meta)
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case "assistant":
        // Count assistant messages with text content (not just tool_use)
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case "attachment":
      case "system":
      case "progress":
        // These message types are not counted as visible conversation turns
        break
    }
  }
  return count
}

function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  // Get the first user message for the prompt
  const firstPrompt = extractFirstPrompt(transcript)

  // Create timestamps from message timestamps
  const created = new Date(firstMessage.timestamp)
  const modified = new Date(lastMessage.timestamp)

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created,
    modified,
    firstPrompt,
    messageCount: countVisibleMessages(transcript),
    isSidechain: firstMessage.isSidechain,
    teamName: firstMessage.teamName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots: fileHistorySnapshots,
    attributionSnapshots: attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}


/**
 * Append an entry to a session file. Creates the parent dir if missing.
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
function appendEntryToFile(fullPath: string, entry: Record<string, unknown>): void {
  // Session-exit / compaction metadata re-appends bypass enqueueWrite, so
  // mirror them explicitly — otherwise last-prompt, title, tag, goal, etc.
  // never reach the SQLite transcript store.
  const mirror = project?.entryMirror
  if (mirror !== undefined) {
    const entryWithMeta = entry as { sessionId?: unknown }
    const sessionId = typeof entryWithMeta.sessionId === "string" ? entryWithMeta.sessionId : null
    if (sessionId !== null) {
      void mirror(entry as Entry, { sessionId, isSidechain: false, isCompaction: false })
    }
  }
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + "\n"
  // Honor the file-write sink (the app disables JSONL writes) — this sync
  // path bypasses appendToFile, so route through the override when set.
  const sink = project?.getAppendToFileSink()
  if (sink !== undefined) {
    void sink(fullPath, line)
    return
  }
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}

/**
 * Sync tail read for reAppendSessionMetadata's external-writer check.
 * fstat on the already-open fd (no extra path lookup); reads the same
 * LITE_READ_BUF_SIZE window that tail reads scan. Returns empty
 * string on any error so callers fall through to unconditional behavior.
 */
function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, "r")
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset))
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString("utf8", 0, bytesRead)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync can throw; swallow to preserve return '' contract
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: "user" | "auto" = "user",
) {
  // Fall back to computed path if fullPath is not provided
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: "custom-title",
    customTitle,
    sessionId,
  })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }

}

/**
 * Persist an AI-generated title to the JSONL as a distinct `ai-title` entry.
 *
 * Writing a separate entry type (vs. reusing `custom-title`) is load-bearing:
 * - Read preference: readers prefer `customTitle` field over `aiTitle`, so
 *   a user rename always wins regardless of append order.
 * - Resume safety: `loadTranscriptFile` only populates the `customTitles`
 *   Map from `custom-title` entries, so `restoreSessionMetadata` never
 *   caches an AI title and `reAppendSessionMetadata` never re-appends one
 *   at EOF — avoiding the clobber-on-resume bug where a stale AI title
 *   overwrites a mid-session user rename.
 * - CAS semantics: VS Code's `onlyIfNoCustomTitle` check scans for the
 *   `customTitle` field only, so AI can overwrite its own previous AI
 *   title but never a user title.
 * - Metrics: `wren_session_renamed` is not fired for AI titles.
 *
 * Because the entry is never re-appended, it scrolls out of the 64KB tail
 * window once enough messages accumulate. Readers (tail reads,
 * `listSessionsImpl`, VS Code `fetchSessions`) fall back to scanning the
 * head buffer for `aiTitle` in that case. Both head and tail reads are
 * bounded (64KB each via `extractLastJsonStringField`), never a full scan.
 *
 * Callers with a stale-write guard (e.g., VS Code client) should prefer
 * passing `persist: false` to the SDK control request and persisting
 * through their own rename path after the guard passes, to avoid a race
 * where the AI title lands after a mid-flight user rename.
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: "ai-title",
    aiTitle,
    sessionId,
  })
}

/**
 * Append a periodic task summary for `wren ps`. Unlike ai-title this is
 * not re-appended by reAppendSessionMetadata — it's a rolling snapshot of
 * what the agent is doing *now*, so staleness is fine; ps reads the most
 * recent one from the tail.
 */
export function saveTaskSummary(sessionId: UUID, summary: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: "task-summary",
    summary,
    sessionId,
    timestamp: new Date().toISOString(),
  })
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  // Fall back to computed path if fullPath is not provided
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: "tag", tag, sessionId })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }

}

/**
 * Persist a goal-state checkpoint to the JSONL transcript. Called by
 * src/services/goal/goalStorage.ts on every mutation. The latest entry
 * wins on read; older entries are harmlessly ignored.
 *
 * Cached on Project so reAppendSessionMetadata can keep the goal alive
 * past compaction's tail-read window.
 */
export function saveGoal(sessionId: UUID, state: GoalState, fullPath?: string): void {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: "goal",
    sessionId,
    state,
    timestamp: new Date().toISOString(),
  })
  if (sessionId === getSessionId()) {
    getProject().currentSessionGoal = state
  }
}

/**
 * Persist a "goal cleared" tombstone so a future --resume cannot
 * resurrect the goal from a prior `goal` entry. Also drops the
 * in-memory cache for the current session.
 */
export function clearGoalEntry(sessionId: UUID, fullPath?: string): void {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: "goal-cleared",
    sessionId,
    timestamp: new Date().toISOString(),
  })
  if (sessionId === getSessionId()) {
    getProject().currentSessionGoal = undefined
  }
}

/**
 * Link a session to a GitHub pull request.
 * This stores the PR number, URL, and repository for tracking and navigation.
 */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: "pr-link",
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
  // Cache for current session so reAppendSessionMetadata can re-write after compaction
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }

}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // Only returns tag for current session (the only one we cache)
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(sessionId: SessionId): string | undefined {
  // Only returns title for current session (the only one we cache)
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

/**
 * Restore session metadata into in-memory cache on resume.
 * Populates the cache so metadata is available for display (e.g. the
 * agent banner) and re-appended on session exit via reAppendSessionMetadata.
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: "coordinator" | "normal"
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  goal?: GoalState
}): void {
  const project = getProject()
  // ??= so --name (cacheSessionTitle) wins over the resumed
  // session's title. REPL.tsx clears before calling, so /resume is unaffected.
  if (meta.customTitle) project.currentSessionTitle ??= meta.customTitle
  if (meta.tag !== undefined) project.currentSessionTag = meta.tag || undefined
  if (meta.agentName) project.currentSessionAgentName = meta.agentName
  if (meta.agentColor) project.currentSessionAgentColor = meta.agentColor
  if (meta.agentSetting) project.currentSessionAgentSetting = meta.agentSetting
  if (meta.mode) project.currentSessionMode = meta.mode
  if (meta.worktreeSession !== undefined) project.currentSessionWorktree = meta.worktreeSession
  if (meta.prNumber !== undefined) project.currentSessionPrNumber = meta.prNumber
  if (meta.prUrl) project.currentSessionPrUrl = meta.prUrl
  if (meta.prRepository) project.currentSessionPrRepository = meta.prRepository
  if (meta.goal) project.currentSessionGoal = meta.goal
}

/**
 * Clear all cached session metadata (title, tag, agent name/color).
 * Called when /clear creates a new session so stale metadata
 * from the previous session does not leak into the new one.
 */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionGoal = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * Re-append cached session metadata (custom title, tag) to the end of the
 * transcript file. Call this after compaction so the metadata stays within
 * the 16KB tail window that tail reads scan during progressive loading.
 * Without this, enough post-compaction messages can push the metadata entry
 * out of the window, causing `--resume` to show the auto-generated firstPrompt
 * instead of the user-set session name.
 */
export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: "user" | "auto" = "user",
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: "agent-name", agentName, sessionId })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }

}

export async function saveAgentColor(sessionId: UUID, agentColor: string, fullPath?: string) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: "agent-color",
    agentColor,
    sessionId,
  })
  // Cache for current session only (for immediate visibility)
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }

}

/**
 * Cache the session agent setting. Written to disk by materializeSessionFile
 * on the first user message, and re-stamped by reAppendSessionMetadata on exit.
 * Cache-only here to avoid creating metadata-only session files at startup.
 */
export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

/**
 * Cache a session title set at startup (--name). Written to disk by
 * materializeSessionFile on the first user message. Cache-only here so no
 * orphan metadata-only file is created before the session ID is finalized.
 */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/**
 * Cache the session mode. Written to disk by materializeSessionFile on the
 * first user message, and re-stamped by reAppendSessionMetadata on exit.
 * Cache-only here to avoid creating metadata-only session files at startup.
 */
export function saveMode(mode: "coordinator" | "normal"): void {
  getProject().currentSessionMode = mode
}

/**
 * Record the session's worktree state for --resume. Written to disk by
 * materializeSessionFile on the first user message and re-stamped by
 * reAppendSessionMetadata on exit. Pass null when exiting a worktree
 * so --resume knows not to cd back into it.
 */
export function saveWorktreeState(worktreeSession: PersistedWorktreeSession | null): void {
  // Strip ephemeral fields (creationDurationMs, usedSparsePaths) that callers
  // may pass via full WorktreeSession objects — TypeScript structural typing
  // allows this, but we don't want them serialized to the transcript.
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  const project = getProject()
  project.currentSessionWorktree = stripped
  // Write eagerly when the file already exists (mid-session enter/exit).
  // For --worktree startup, sessionFile is null — materializeSessionFile
  // will write it on the first message via reAppendSessionMetadata.
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: "worktree-state",
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}


/**
 * Metadata entry types that can appear before a compact boundary but must
 * still be loaded (they're session-scoped, not message-scoped).
 * Kept as raw JSON string markers for cheap line filtering during streaming.
 */
const METADATA_TYPE_MARKERS = [
  '"type":"summary"',
  '"type":"custom-title"',
  '"type":"tag"',
  '"type":"agent-name"',
  '"type":"agent-color"',
  '"type":"agent-setting"',
  '"type":"mode"',
  '"type":"worktree-state"',
  '"type":"goal"',
  '"type":"goal-cleared"',
  '"type":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map((m) => Buffer.from(m))
// Longest marker is 22 bytes; +1 for leading `{` = 23.
const METADATA_PREFIX_BOUND = 25

// null = carry spans whole chunk. Skips concat when carry provably isn't
// a metadata line (markers sit at byte 1 after `{`).
function resolveMetadataBuf(carry: Buffer | null, chunkBuf: Buffer): Buffer | null {
  if (carry === null || carry.length === 0) return chunkBuf
  if (carry.length < METADATA_PREFIX_BOUND) {
    return Buffer.concat([carry, chunkBuf])
  }
  if (carry[0] === 0x7b /* { */) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.compare(m, 0, m.length, 1, 1 + m.length) === 0) {
        return Buffer.concat([carry, chunkBuf])
      }
    }
  }
  const firstNl = chunkBuf.indexOf(0x0a)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

/**
 * Lightweight forward scan of [0, endOffset) collecting only metadata-entry lines.
 * Uses raw Buffer chunks and byte-level marker matching — no readline, no per-line
 * string conversion for the ~99% of lines that are message content.
 *
 * Fast path: if a chunk contains zero markers (the common case — metadata entries
 * are <50 per session), the entire chunk is skipped without line splitting.
 */
async function scanPreBoundaryMetadata(filePath: string, endOffset: number): Promise<string[]> {
  const { createReadStream } = await import("fs")
  const NEWLINE = 0x0a

  const stream = createReadStream(filePath, { end: endOffset - 1 })
  const metadataLines: string[] = []
  let carry: Buffer | null = null

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = resolveMetadataBuf(carry, chunkBuf)
    if (buf === null) {
      carry = null
      continue
    }

    // Fast path: most chunks contain zero metadata markers. Skip line splitting.
    let hasAnyMarker = false
    for (const m of METADATA_MARKER_BUFS) {
      if (buf.includes(m)) {
        hasAnyMarker = true
        break
      }
    }

    if (hasAnyMarker) {
      let lineStart = 0
      let nl = buf.indexOf(NEWLINE)
      while (nl !== -1) {
        // Bounded marker check: only look within this line's byte range
        for (const m of METADATA_MARKER_BUFS) {
          const mIdx = buf.indexOf(m, lineStart)
          if (mIdx !== -1 && mIdx < nl) {
            metadataLines.push(buf.toString("utf-8", lineStart, nl))
            break
          }
        }
        lineStart = nl + 1
        nl = buf.indexOf(NEWLINE, lineStart)
      }
      carry = buf.subarray(lineStart)
    } else {
      // No markers in this chunk — just preserve the incomplete trailing line
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    // Guard against quadratic carry growth for pathological huge lines
    // (e.g., a 10 MB tool-output line with no newline). Real metadata entries
    // are <1 KB, so if carry exceeds this we're mid-message-content — drop it.
    if (carry.length > 64 * 1024) carry = null
  }

  // Final incomplete line (no trailing newline at endOffset)
  if (carry !== null && carry.length > 0) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.includes(m)) {
        metadataLines.push(carry.toString("utf-8"))
        break
      }
    }
  }

  return metadataLines
}

/**
 * Byte-level pre-filter that excises dead fork branches before parseJSONL.
 *
 * Every rewind/ctrl-z leaves an orphaned chain branch in the append-only
 * JSONL forever. buildConversationChain walks parentUuid from the latest leaf
 * and discards everything else, but by then parseJSONL has already paid to
 * JSON.parse all of it. Measured on fork-heavy sessions:
 *
 *   41 MB, 99% dead: parseJSONL 56.0 ms -> 3.9 ms (-93%)
 *   151 MB, 92% dead: 47.3 ms -> 9.4 ms (-80%)
 *
 * Sessions with few dead branches (5-7%) see a small win from the overhead of
 * the index pass roughly canceling the parse savings, so this is gated on
 * buffer size (same threshold as SKIP_PRECOMPACT_THRESHOLD).
 *
 * Relies on two invariants verified across 25k+ message lines in local
 * sessions (0 violations):
 *
 *   1. Transcript messages always serialize with parentUuid as the first key.
 *      JSON.stringify emits keys in insertion order and recordTranscript's
 *      object literal puts parentUuid first. So `{"parentUuid":` is a stable
 *      line prefix that distinguishes transcript messages from metadata.
 *
 *   2. Top-level uuid detection is handled by a suffix check + depth check
 *      (see inline comment in the scan loop). toolUseResult/mcpMeta serialize
 *      AFTER uuid with arbitrary server-controlled objects, and agent_progress
 *      entries serialize a nested Message in data BEFORE uuid — both can
 *      produce nested `"uuid":"<36>","timestamp":"` bytes, so suffix alone
 *      is insufficient. When multiple suffix matches exist, a brace-depth
 *      scan disambiguates.
 *
 * The append-only write discipline guarantees parents appear at earlier file
 * offsets than children, so walking backward from EOF always finds them.
 */

/**
 * Disambiguate multiple `"uuid":"<36>","timestamp":"` matches in one line by
 * finding the one at JSON nesting depth 1. String-aware brace counter:
 * `{`/`}` inside string values don't count; `\"` and `\\` inside strings are
 * handled. Candidates is sorted ascending (the scan loop produces them in
 * byte order). Returns the first depth-1 candidate, or the last candidate if
 * none are at depth 1 (shouldn't happen for well-formed JSONL — depth-1 is
 * where the top-level object's fields live).
 *
 * Only called when ≥2 suffix matches exist (agent_progress with a nested
 * Message, or mcpMeta with a coincidentally-suffixed object). Cost is
 * O(max(candidates) - lineStart) — one forward byte pass, stopping at the
 * first depth-1 hit.
 */
function pickDepthOneUuidCandidate(buf: Buffer, lineStart: number, candidates: number[]): number {
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const OPEN_BRACE = 0x7b
  const CLOSE_BRACE = 0x7d
  let depth = 0
  let inString = false
  let escapeNext = false
  let ci = 0
  for (let i = lineStart; ci < candidates.length; i++) {
    if (i === candidates[ci]) {
      if (depth === 1 && !inString) return candidates[ci]!
      ci++
    }
    const b = buf[i]!
    if (escapeNext) {
      escapeNext = false
    } else if (inString) {
      if (b === BACKSLASH) escapeNext = true
      else if (b === QUOTE) inString = false
    } else if (b === QUOTE) inString = true
    else if (b === OPEN_BRACE) depth++
    else if (b === CLOSE_BRACE) depth--
  }
  return candidates.at(-1)!
}

function walkChainBeforeParse(buf: Buffer): Buffer {
  const NEWLINE = 0x0a
  const OPEN_BRACE = 0x7b
  const QUOTE = 0x22
  const PARENT_PREFIX = Buffer.from('{"parentUuid":')
  const UUID_KEY = Buffer.from('"uuid":"')
  const SIDECHAIN_TRUE = Buffer.from('"isSidechain":true')
  const UUID_LEN = 36
  const TS_SUFFIX = Buffer.from('","timestamp":"')
  const TS_SUFFIX_LEN = TS_SUFFIX.length
  const PREFIX_LEN = PARENT_PREFIX.length
  const KEY_LEN = UUID_KEY.length

  // Stride-3 flat index of transcript messages: [lineStart, lineEnd, parentStart].
  // parentStart is the byte offset of the parent uuid's first char, or -1 for null.
  // Metadata lines (summary, mode, file-history-snapshot, etc.) go in metaRanges
  // unfiltered - they lack the parentUuid prefix and downstream needs all of them.
  const msgIdx: number[] = []
  const metaRanges: number[] = []
  const uuidToSlot = new Map<string, number>()

  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    if (
      lineEnd - pos > PREFIX_LEN &&
      buf[pos] === OPEN_BRACE &&
      buf.compare(PARENT_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      // `{"parentUuid":null,` or `{"parentUuid":"<36 chars>",`
      const parentStart = buf[pos + PREFIX_LEN] === QUOTE ? pos + PREFIX_LEN + 1 : -1
      // The top-level uuid is immediately followed by `","timestamp":"` in
      // user/assistant/attachment entries (the create* helpers put them
      // adjacent; both always defined). But the suffix is NOT unique:
      //   - agent_progress entries carry a nested Message in data.message,
      //     serialized BEFORE top-level uuid — that inner Message has its
      //     own uuid,timestamp adjacent, so its bytes also satisfy the
      //     suffix check.
      //   - mcpMeta/toolUseResult come AFTER top-level uuid and hold
      //     server-controlled Record<string,unknown> — a server returning
      //     {uuid:"<36>",timestamp:"..."} would also match.
      // Collect all suffix matches; a single one is unambiguous (common
      // case), multiple need a brace-depth check to pick the one at
      // JSON nesting depth 1. Entries with NO suffix match (some progress
      // variants put timestamp BEFORE uuid → `"uuid":"<36>"}` at EOL)
      // have only one `"uuid":"` and the first-match fallback is sound.
      let firstAny = -1
      let suffix0 = -1
      let suffixN: number[] | undefined
      let from = pos
      for (;;) {
        const next = buf.indexOf(UUID_KEY, from)
        if (next < 0 || next >= lineEnd) break
        if (firstAny < 0) firstAny = next
        const after = next + KEY_LEN + UUID_LEN
        if (
          after + TS_SUFFIX_LEN <= lineEnd &&
          buf.compare(TS_SUFFIX, 0, TS_SUFFIX_LEN, after, after + TS_SUFFIX_LEN) === 0
        ) {
          if (suffix0 < 0) suffix0 = next
          else (suffixN ??= [suffix0]).push(next)
        }
        from = next + KEY_LEN
      }
      const uk = suffixN
        ? pickDepthOneUuidCandidate(buf, pos, suffixN)
        : suffix0 >= 0
          ? suffix0
          : firstAny
      if (uk >= 0) {
        const uuidStart = uk + KEY_LEN
        // UUIDs are pure ASCII so latin1 avoids UTF-8 decode overhead.
        const uuid = buf.toString("latin1", uuidStart, uuidStart + UUID_LEN)
        uuidToSlot.set(uuid, msgIdx.length)
        msgIdx.push(pos, lineEnd, parentStart)
      } else {
        metaRanges.push(pos, lineEnd)
      }
    } else {
      metaRanges.push(pos, lineEnd)
    }
    pos = lineEnd
  }

  // Leaf = last non-sidechain entry. isSidechain is the 2nd or 3rd key
  // (after parentUuid, maybe logicalParentUuid) so indexOf from lineStart
  // finds it within a few dozen bytes when present; when absent it spills
  // into the next line, caught by the bounds check.
  let leafSlot = -1
  for (let i = msgIdx.length - 3; i >= 0; i -= 3) {
    const sc = buf.indexOf(SIDECHAIN_TRUE, msgIdx[i]!)
    if (sc === -1 || sc >= msgIdx[i + 1]!) {
      leafSlot = i
      break
    }
  }
  if (leafSlot < 0) return buf

  // Walk parentUuid to root. Collect kept-message line starts and sum their
  // byte lengths so we can decide whether the concat is worth it. A dangling
  // parent (uuid not in file) is the normal termination for forked sessions
  // and post-boundary chains -- same semantics as buildConversationChain.
  // Correctness against index poisoning rests on the timestamp suffix check
  // above: a nested `"uuid":"` match without the suffix never becomes uk.
  const seen = new Set<number>()
  const chain = new Set<number>()
  let chainBytes = 0
  let slot: number | undefined = leafSlot
  while (slot !== undefined) {
    if (seen.has(slot)) break
    seen.add(slot)
    chain.add(msgIdx[slot]!)
    chainBytes += msgIdx[slot + 1]! - msgIdx[slot]!
    const parentStart = msgIdx[slot + 2]!
    if (parentStart < 0) break
    const parent = buf.toString("latin1", parentStart, parentStart + UUID_LEN)
    slot = uuidToSlot.get(parent)
  }

  // parseJSONL cost scales with bytes, not entry count. A session can have
  // thousands of dead entries by count but only single-digit-% of bytes if
  // the dead branches are short turns and the live chain holds the fat
  // assistant responses (measured: 107 MB session, 69% dead entries, 30%
  // dead bytes - index+concat overhead exceeded parse savings). Gate on
  // bytes: only stitch if we would drop at least half the buffer. Metadata
  // is tiny so len - chainBytes approximates dead bytes closely enough.
  // Near break-even the concat memcpy (copying chainBytes into a fresh
  // allocation) dominates, so a conservative 50% gate stays safely on the
  // winning side.
  if (len - chainBytes < len >> 1) return buf

  // Merge chain entries with metadata in original file order. Both msgIdx and
  // metaRanges are already sorted by offset; interleave them into subarray
  // views and concat once.
  const parts: Buffer[] = []
  let m = 0
  for (let i = 0; i < msgIdx.length; i += 3) {
    const start = msgIdx[i]!
    while (m < metaRanges.length && metaRanges[m]! < start) {
      parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
      m += 2
    }
    if (chain.has(start)) {
      parts.push(buf.subarray(start, msgIdx[i + 1]!))
    }
  }
  while (m < metaRanges.length) {
    parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
    m += 2
  }
  return Buffer.concat(parts)
}

/**
 * Loads all messages, summaries, and file history snapshots from a transcript file.
 * Returns the messages, summaries, custom titles, tags, file history snapshots, and attribution snapshots.
 */
type PartitionedSessionData = {
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  goals: Map<UUID, GoalState>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}

/**
 * Partition an ordered list of transcript entries into the session-data maps.
 * Shared by the JSONL loader (loadTranscriptFile) and the SQLite loader
 * (eventsToSessionData) so both paths stay in sync.
 */
function partitionEntries(entries: readonly Entry[]): PartitionedSessionData {
  const messages = new Map<UUID, TranscriptMessage>()
  const summaries = new Map<UUID, string>()
  const customTitles = new Map<UUID, string>()
  const tags = new Map<UUID, string>()
  const agentNames = new Map<UUID, string>()
  const agentColors = new Map<UUID, string>()
  const agentSettings = new Map<UUID, string>()
  const prNumbers = new Map<UUID, number>()
  const prUrls = new Map<UUID, string>()
  const prRepositories = new Map<UUID, string>()
  const modes = new Map<UUID, string>()
  const worktreeStates = new Map<UUID, PersistedWorktreeSession | null>()
  const goals = new Map<UUID, GoalState>()
  const fileHistorySnapshots = new Map<UUID, FileHistorySnapshotMessage>()
  const attributionSnapshots = new Map<UUID, AttributionSnapshotMessage>()
  const contentReplacements = new Map<UUID, ContentReplacementRecord[]>()
  const agentContentReplacements = new Map<AgentId, ContentReplacementRecord[]>()
  // Array, not Map — commit order matters (nested collapses).
  const contextCollapseCommits: ContextCollapseCommitEntry[] = []
  // Last-wins — later entries supersede.
  let contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined

  // Bridge map for legacy progress entries: progress_uuid → progress_parent_uuid.
  // PR #24099 removed progress from isTranscriptMessage, so old transcripts with
  // progress in the parentUuid chain would truncate at buildConversationChain
  // when messages.get(progressUuid) returns undefined. Since transcripts are
  // append-only (parents before children), we record each progress→parent link
  // as we see it, chain-resolving through consecutive progress entries, then
  // rewrite any subsequent message whose parentUuid lands in the bridge.
  const progressBridge = new Map<UUID, UUID | null>()

  for (const entry of entries) {
    // Legacy progress check runs before the Entry-typed else-if chain —
    // progress is not in the Entry union, so checking it after TypeScript
    // has narrowed `entry` intersects to `never`.
    if (isLegacyProgressEntry(entry)) {
      // Chain-resolve through consecutive progress entries so a later
      // message pointing at the tail of a progress run bridges to the
      // nearest non-progress ancestor in one lookup.
      const parent = entry.parentUuid
      progressBridge.set(
        entry.uuid,
        parent && progressBridge.has(parent) ? (progressBridge.get(parent) ?? null) : parent,
      )
      continue
    }
    if (isTranscriptMessage(entry)) {
      if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
        entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
      }
      messages.set(entry.uuid, entry)
      // Compact boundary: prior marble-origami-commit entries reference
      // messages that won't be in the post-boundary chain. The >5MB
      // backward-scan path discards them naturally by never reading the
      // pre-boundary bytes; the <5MB path reads everything, so discard
      // here. Without this, getStats().collapsedSpans in /context
      // overcounts (projectView silently skips the stale commits but
      // they're still in the log).
      if (isCompactBoundaryMessage(entry)) {
        contextCollapseCommits.length = 0
        contextCollapseSnapshot = undefined
      }
    } else if (entry.type === "summary" && entry.leafUuid) {
      summaries.set(entry.leafUuid, entry.summary)
    } else if (entry.type === "custom-title" && entry.sessionId) {
      customTitles.set(entry.sessionId, entry.customTitle)
    } else if (entry.type === "tag" && entry.sessionId) {
      tags.set(entry.sessionId, entry.tag)
    } else if (entry.type === "agent-name" && entry.sessionId) {
      agentNames.set(entry.sessionId, entry.agentName)
    } else if (entry.type === "agent-color" && entry.sessionId) {
      agentColors.set(entry.sessionId, entry.agentColor)
    } else if (entry.type === "agent-setting" && entry.sessionId) {
      agentSettings.set(entry.sessionId, entry.agentSetting)
    } else if (entry.type === "mode" && entry.sessionId) {
      modes.set(entry.sessionId, entry.mode)
    } else if (entry.type === "worktree-state" && entry.sessionId) {
      worktreeStates.set(entry.sessionId, entry.worktreeSession)
    } else if (entry.type === "goal" && entry.sessionId) {
      goals.set(entry.sessionId, entry.state)
    } else if (entry.type === "goal-cleared" && entry.sessionId) {
      goals.delete(entry.sessionId)
    } else if (entry.type === "pr-link" && entry.sessionId) {
      prNumbers.set(entry.sessionId, entry.prNumber)
      prUrls.set(entry.sessionId, entry.prUrl)
      prRepositories.set(entry.sessionId, entry.prRepository)
    } else if (entry.type === "file-history-snapshot") {
      fileHistorySnapshots.set(entry.messageId, entry)
    } else if (entry.type === "attribution-snapshot") {
      attributionSnapshots.set(entry.messageId, entry)
    } else if (entry.type === "content-replacement") {
      // Subagent decisions key by agentId (sidechain resume); main-thread
      // decisions key by sessionId (/resume).
      if (entry.agentId) {
        const existing = agentContentReplacements.get(entry.agentId) ?? []
        agentContentReplacements.set(entry.agentId, existing)
        existing.push(...entry.replacements)
      } else {
        const existing = contentReplacements.get(entry.sessionId) ?? []
        contentReplacements.set(entry.sessionId, existing)
        existing.push(...entry.replacements)
      }
    } else if (entry.type === "marble-origami-commit") {
      contextCollapseCommits.push(entry)
    } else if (entry.type === "marble-origami-snapshot") {
      contextCollapseSnapshot = entry
    }
  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    worktreeStates,
    goals,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
  }
}

/**
 * Compute leaf UUIDs once at load time.
 * Only user/assistant messages should be considered as leaves for anchoring resume.
 * Other message types (system, attachment) are metadata or auxiliary and shouldn't
 * anchor a conversation chain.
 *
 * We use standard parent relationship for main chain detection, but also need to
 * handle cases where the last message is a system/metadata message.
 * For each conversation chain (identified by following parent links), the leaf
 * is the most recent user/assistant message.
 */
function computeLeafUuids(
  messages: Map<UUID, TranscriptMessage>,
): { leafUuids: Set<UUID>; hasCycle: boolean } {
  const allMessages = [...messages.values()]

  // Standard leaf computation using parent relationships
  const parentUuids = new Set(
    allMessages.map((msg) => msg.parentUuid).filter((uuid): uuid is UUID => uuid !== null),
  )

  // Find all terminal messages (messages with no children)
  const terminalMessages = allMessages.filter((msg) => !parentUuids.has(msg.uuid))

  const leafUuids = new Set<UUID>()
  let hasCycle = false

  if (getLocalFeatureValue("wren_pebble_leaf_prune", false)) {
    // Build a set of UUIDs that have user/assistant children
    // (these are mid-conversation nodes, not dead ends)
    const hasUserAssistantChild = new Set<UUID>()
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === "user" || msg.type === "assistant")) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }

    // For each terminal message, walk back to find the nearest user/assistant ancestor.
    // Skip ancestors that already have user/assistant children - those are mid-conversation
    // nodes where the conversation continued (e.g., an assistant tool_use message whose
    // progress child is terminal, but whose tool_result child continues the conversation).
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === "user" || current.type === "assistant") {
          if (!hasUserAssistantChild.has(current.uuid)) {
            leafUuids.add(current.uuid)
          }
          break
        }
        current = current.parentUuid ? messages.get(current.parentUuid) : undefined
      }
    }
  } else {
    // Original leaf computation: walk back from terminal messages to find
    // the nearest user/assistant ancestor unconditionally
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === "user" || current.type === "assistant") {
          leafUuids.add(current.uuid)
          break
        }
        current = current.parentUuid ? messages.get(current.parentUuid) : undefined
      }
    }
  }

  return { leafUuids, hasCycle }
}

export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  goals: Map<UUID, GoalState>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
}> {
  let partitioned: PartitionedSessionData | undefined
  let metadataPartitioned: PartitionedSessionData | undefined

  try {
    // For large transcripts, avoid materializing megabytes of stale content.
    // Single forward chunked read: attribution-snapshot lines are skipped at
    // the fd level (never buffered), compact boundaries truncate the
    // accumulator in-stream. Peak allocation is the OUTPUT size, not the
    // file size — a 151 MB session that is 84% stale attr-snaps allocates
    // ~32 MB instead of 159+64 MB. This matters because mimalloc does not
    // return those pages to the OS even after JS-level GC frees the backing
    // buffers (measured: arrayBuffers=0 after Bun.gc(true) but RSS stuck at
    // ~316 MB on the old scan+strip path vs ~155 MB here).
    //
    // Pre-boundary metadata (agent-setting, mode, pr-link, etc.) is recovered
    // via a cheap byte-level forward scan of [0, boundary).
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (!isEnvTruthy(process.env.WREN_DISABLE_PRECOMPACT_SKIP)) {
      const { size } = await stat(filePath)
      if (size > SKIP_PRECOMPACT_THRESHOLD) {
        const scan = await readTranscriptForLoad(filePath, size)
        buf = scan.postBoundaryBuf
        hasPreservedSegment = scan.hasPreservedSegment
        // >0 means we truncated pre-boundary bytes and must recover
        // session-scoped metadata from that range. A preservedSegment
        // boundary does not truncate (preserved messages are physically
        // pre-boundary), so offset stays 0 unless an EARLIER non-preserved
        // boundary already truncated — in which case the preserved messages
        // for the later boundary are post-that-earlier-boundary and were
        // kept, and we still want the metadata scan.
        if (scan.boundaryStartOffset > 0) {
          metadataLines = await scanPreBoundaryMetadata(filePath, scan.boundaryStartOffset)
        }
      }
    }
    buf ??= await readFile(filePath)
    // For large buffers (which here means readTranscriptForLoad output with
    // attr-snaps already stripped at the fd level — the <5MB readFile path
    // falls through the size gate below), the dominant cost is parsing dead
    // fork branches that buildConversationChain would discard anyway. Skip
    // when the caller needs all
    // leaves (loadAllLogsFromSessionFile for /insights picks the branch with
    // most user messages, not the latest), when the boundary has a
    // preservedSegment (those messages keep their pre-compact parentUuid on
    // disk -- applyPreservedSegmentRelinks splices them in-memory AFTER
    // parse, so a pre-parse chain walk would drop them as orphans), and when
    // WREN_DISABLE_PRECOMPACT_SKIP is set (that kill switch means
    // "load everything, skip nothing"; this is another skip-before-parse
    // optimization and the scan it depends on for hasPreservedSegment did
    // not run).
    if (
      !opts?.keepAllLeaves &&
      !hasPreservedSegment &&
      !isEnvTruthy(process.env.WREN_DISABLE_PRECOMPACT_SKIP) &&
      buf.length > SKIP_PRECOMPACT_THRESHOLD
    ) {
      buf = walkChainBeforeParse(buf)
    }

    // First pass: process metadata-only lines collected during the boundary scan.
    // These populate the session-scoped maps (agentSettings, modes, prNumbers,
    // etc.) for entries written before the compact boundary. Any overlap with
    // the post-boundary buffer is harmless — the main partition below is merged
    // on top, so later (post-boundary) values overwrite earlier ones.
    if (metadataLines && metadataLines.length > 0) {
      const metaEntries = parseJSONL<Entry>(Buffer.from(metadataLines.join("\n")))
      metadataPartitioned = partitionEntries(metaEntries)
    }

    const entries = parseJSONL<Entry>(buf)
    partitioned = partitionEntries(entries)
  } catch {
    // File doesn't exist or can't be read
  }

  const mainPartition = partitioned ?? partitionEntries([])
  const merged: PartitionedSessionData =
    metadataPartitioned === undefined
      ? mainPartition
      : {
          ...mainPartition,
          // The metadata pre-pass only recovered pre-boundary values; the main
          // (post-boundary) partition wins on overlap.
          summaries: new Map([...metadataPartitioned.summaries, ...mainPartition.summaries]),
          customTitles: new Map([
            ...metadataPartitioned.customTitles,
            ...mainPartition.customTitles,
          ]),
          tags: new Map([...metadataPartitioned.tags, ...mainPartition.tags]),
          agentNames: new Map([...metadataPartitioned.agentNames, ...mainPartition.agentNames]),
          agentColors: new Map([...metadataPartitioned.agentColors, ...mainPartition.agentColors]),
          agentSettings: new Map([
            ...metadataPartitioned.agentSettings,
            ...mainPartition.agentSettings,
          ]),
          modes: new Map([...metadataPartitioned.modes, ...mainPartition.modes]),
          worktreeStates: new Map([
            ...metadataPartitioned.worktreeStates,
            ...mainPartition.worktreeStates,
          ]),
          goals: new Map([...metadataPartitioned.goals, ...mainPartition.goals]),
          prNumbers: new Map([...metadataPartitioned.prNumbers, ...mainPartition.prNumbers]),
          prUrls: new Map([...metadataPartitioned.prUrls, ...mainPartition.prUrls]),
          prRepositories: new Map([
            ...metadataPartitioned.prRepositories,
            ...mainPartition.prRepositories,
          ]),
        }
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    worktreeStates,
    goals,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
  } = merged

  applyPreservedSegmentRelinks(messages)
  applySnipRemovals(messages)

  const { leafUuids, hasCycle } = computeLeafUuids(messages)
  if (hasCycle) {

  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    worktreeStates,
    goals,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
    leafUuids,
  }
}

/**
 * Loads all messages, summaries, file history snapshots, and attribution snapshots for a session.
 * Reads from the SQLite engine_event table (storage of record). Falls back to
 * JSONL only for pre-migration sessions that have no events in the store.
 */
async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  goals: Map<UUID, GoalState>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
}> {
  const store = getTranscriptStore()
  if (store !== null) {
    try {
      const events = await store.events(sessionId)
      if (events.length > 0) {
        return eventsToSessionData(events)
      }
    } catch {
      // fall through to JSONL
    }
  }
  // Legacy fallback: read from JSONL file
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  const result = await loadTranscriptFile(sessionFile)
  return {
    ...result,
    leafUuids: result.leafUuids,
    agentContentReplacements: result.agentContentReplacements,
  }
}

export type EngineSessionResume = {
  readonly messages: readonly SerializedMessage[]
  readonly goalState?: GoalState
}

/**
 * Loads the current engine conversation chain for a resumed session.
 * SQLite engine events are authoritative when available; legacy JSONL is used
 * by loadSessionFile for sessions created before the mirror migration.
 */
export async function loadEngineSessionMessages(
  sessionId: string,
): Promise<EngineSessionResume | null> {
  const sid = asSessionId(sessionId) as UUID
  const data = await loadSessionFile(sid)
  if (data.messages.size === 0) return null

  const leaf = findLatestMessage(data.messages.values(), (message) => !message.isSidechain)
  if (leaf === undefined) return null

  return {
    messages: removeExtraFields(buildConversationChain(data.messages, leaf)),
    ...(data.goals.get(sid) !== undefined && {
      goalState: data.goals.get(sid),
    }),
  }
}

type SessionDataResult = PartitionedSessionData & { leafUuids: Set<UUID> }

/**
 * Rebuild the session-data maps from the SQLite engine_event log (storage of
 * record). Mirrors loadTranscriptFile's partitioning so both sources produce
 * identical session state. Subagent (sidechain) entries are excluded — they
 * live in per-agent streams, exactly like their own agent-*.jsonl files.
 * Exported for tests; the app uses it through loadSessionFile.
 */
export function eventsToSessionData(events: readonly EngineEvent[]): SessionDataResult {
  const entries = events
    .map((event) => event.payload)
    .filter((payload): payload is Entry => typeof payload === "object" && payload !== null)
  const mainEntries = entries.filter(
    (entry) =>
      (entry as { isSidechain?: unknown }).isSidechain !== true &&
      (entry as { agentId?: unknown }).agentId === undefined,
  )
  const partitioned = partitionEntries(mainEntries)
  applyPreservedSegmentRelinks(partitioned.messages)
  applySnipRemovals(partitioned.messages)
  const { leafUuids, hasCycle } = computeLeafUuids(partitioned.messages)
  if (hasCycle) {

  }
  return { ...partitioned, leafUuids }
}

/**
 * Bounded cache for {@link getSessionMessages}. Bounded at
 * {@link MAX_CACHED_SESSION_FILES} to prevent unbounded Map growth in
 * long-running daemon / swarm sessions that spawn many agents — mirrors
 * the existingSessionFiles pattern above. Entries are evicted in FIFO
 * order via `Map` insertion order.
 */
const sessionMessagesCache = new Map<UUID, Promise<Set<UUID>>>()

/**
 * Gets message UUIDs for a specific session without loading all sessions.
 * Cached (bounded) to avoid re-reading the same session file multiple
 * times. Concurrent calls for the same `sessionId` share one in-flight
 * load promise.
 *
 * Exported so tests can verify cache eviction behavior directly; not
 * intended as a public API — prefer {@link doesMessageExistInSession}.
 */
export async function getSessionMessages(sessionId: UUID): Promise<Set<UUID>> {
  const existing = sessionMessagesCache.get(sessionId)
  if (existing !== undefined) {
    return existing
  }
  // Evict oldest entry when at capacity so the Map stays bounded.
  if (sessionMessagesCache.size >= MAX_CACHED_SESSION_FILES) {
    const oldestKey = sessionMessagesCache.keys().next().value
    if (oldestKey !== undefined) {
      sessionMessagesCache.delete(oldestKey)
    }
  }
  const promise = (async () => {
    // Read from SQLite engine_event table (the storage of record since JSONL
    // writes were disabled). Uses messageUuids() — a bare-column index scan
    // — instead of events() which JSON-parses every payload. For a 71k-row
    // session this cuts the load from ~1-2s to ~50ms.
    const store = getTranscriptStore()
    if (store !== null) {
      try {
        const uuids = await store.messageUuids(sessionId)
        return new Set(uuids as UUID[])
      } catch {
        // fall through to file path
      }
    }
    // Legacy fallback: read from JSONL file (pre-migration sessions)
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  })()
  sessionMessagesCache.set(sessionId, promise)
  return promise
}

/** Underlying cache for direct manipulation (priming, clearing, tests). */
export function getSessionMessagesCache(): Map<UUID, Promise<Set<UUID>>> {
  return sessionMessagesCache
}

/**
 * Clear the cached session messages.
 * Call after compaction when old message UUIDs are no longer valid.
 */
export function clearSessionMessagesCache(): void {
  sessionMessagesCache.clear()
}

/**
 * Check if a message UUID exists in the session storage.
 * Uses the indexed hasMessage query when the store is available; falls back
 * to the cached set for pre-migration sessions.
 */
export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const store = getTranscriptStore()
  if (store !== null) {
    return store.hasMessage(sessionId, messageUuid)
  }
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}


/**
 * Retrieves the transcript for a specific agent by agentId.
 * Directly loads the agent-specific transcript file.
 * @param agentId The agent ID to search for
 * @returns The conversation chain and budget replacement records for the agent,
 *          or null if not found
 */
export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  // SQLite mirror is the only path (JSONL fallback removed).
  const fromStore = await getAgentTranscriptFromStore(agentId)
  return fromStore
}

/**
 * Reconstruct an agent transcript from the SQLite mirror: the agent's
 * sidechain stream in engine_event. The stream holds the same full
 * conversation the JSONL agent file used to — fork-inherited messages are
 * sidechain-stamped too — so the leaf/chain logic is identical to the file
 * path. Returns null when the store has no events for this agent.
 */
async function getAgentTranscriptFromStore(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const store = getTranscriptStore()
  if (store === null) return null
  const sessionId = getSessionId()

  let events
  try {
    events = await store.events(sessionId, { sessionId, agentId, isSidechain: true })
  } catch {
    return null
  }

  const messages = new Map<UUID, TranscriptMessage>()
  let contentReplacements: ContentReplacementRecord[] = []
  for (const event of events) {
    const payload = event.payload as Partial<TranscriptMessage> & {
      agentId?: string
      isSidechain?: boolean
      replacements?: ContentReplacementRecord[]
    }
    if (isTranscriptMessage(payload as Entry)) {
      if (payload.agentId === agentId && payload.isSidechain) {
        messages.set((payload as TranscriptMessage).uuid, payload as TranscriptMessage)
      }
    } else if (event.type === "content-replacement" && payload.agentId === agentId) {
      contentReplacements = payload.replacements ?? []
    }
  }

  if (messages.size === 0) return null

  // Find the most recent leaf message with this agentId
  const parentUuids = new Set(Array.from(messages.values()).map((msg) => msg.parentUuid))
  const leafMessage = findLatestMessage(messages.values(), (msg) => !parentUuids.has(msg.uuid))
  if (leafMessage === undefined) return null

  // Build the conversation chain
  const transcript = buildConversationChain(messages, leafMessage)
  const agentTranscript = transcript.filter((msg) => msg.agentId === agentId)

  return {
    messages: agentTranscript.map(({ isSidechain, parentUuid, ...msg }) => msg),
    contentReplacements,
  }
}

// Exported so useLogMessages can sync-compute the last loggable uuid
// without awaiting recordTranscript's return value (race-free hint tracking).
export function isLoggableMessage(m: Message): boolean {
  if (m.type === "progress") return false
  // Filter out most attachments — they may contain sensitive info.
  // When enabled, we allow hook_additional_context through since it contains
  // user-configured hook output that is useful for session context on resume.
  if (m.type === "attachment") {
    if (
      m.attachment!.type === "hook_additional_context" &&
      isEnvTruthy(process.env.WREN_SAVE_HOOK_ADDITIONAL_CONTEXT)
    ) {
      return true
    }
    return false
  }
  return true
}

function collectReplIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.type === "assistant" && Array.isArray(m.message!.content)) {
      for (const b of m.message!.content as Array<{
        type: string
        name: string
        id: string
      }>) {
        if (b.type === "tool_use" && b.name === REPL_TOOL_NAME) {
          ids.add(b.id)
        }
      }
    }
  }
  return ids
}

/**
 * For external users, make REPL invisible in the persisted transcript: strip
 * REPL tool_use/tool_result pairs and promote isVirtual messages to real. On
 * --resume the model then sees a coherent native-tool-call history (assistant
 * called Bash, got result, called Read, got result) without the REPL wrapper.
 * Ant transcripts keep the wrapper so the native REPL usage remains available.
 *
 * replIds is pre-collected from the FULL session array, not the slice being
 * transformed — recordTranscript receives incremental slices where the REPL
 * tool_use (earlier render) and its tool_result (later render, after async
 * execution) land in separate calls. A fresh per-call Set would miss the id
 * and leave an orphaned tool_result on disk.
 */
function transformMessagesForExternalTranscript(
  messages: Transcript,
  replIds: Set<string>,
): Transcript {
  return messages.flatMap((m) => {
    if (m.type === "assistant" && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some((b) => b.type === "tool_use" && b.name === REPL_TOOL_NAME)
      const filtered = hasRepl
        ? content.filter((b) => !(b.type === "tool_use" && b.name === REPL_TOOL_NAME))
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if (m.type === "user" && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some((b) => b.type === "tool_result" && replIds.has(b.tool_use_id))
      const filtered = hasRepl
        ? content.filter((b) => !(b.type === "tool_result" && replIds.has(b.tool_use_id)))
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    // string-content user, system, attachment
    if ("isVirtual" in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}

export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return transformMessagesForExternalTranscript(filtered, collectReplIds(allMessages))
}


import { join, resolve } from "node:path"
import { createWrenAdapter, type WrenAdapter } from "@wren/adapter"
import { getWrenConfigHome } from "@wren/config-node"
import type { WrenEngine } from "@wren/engine"
import {
  closeTranscriptMirror,
  createWrenEngineFactory,
  EngineHistorySnapshot,
  initTranscriptMirror,
  loadEngineSessionMessages,
  mirrorEntryToSqlite,
  setEntryMirror,
  setTranscriptFileSink,
  WorkspaceMcpHost,
} from "@wren/engine"
import { createSqliteSessionStore } from "@wren/storage"
import { initWrenConfig } from "./configInit"

export type RunContext = {
  readonly cwd: string
  readonly adapter: WrenAdapter
  readonly resolvedModel: string
  dispose(): Promise<void>
}

function dbPath(): string {
  return join(getWrenConfigHome(), "sessions.db")
}

/**
 * Builds the full agent runtime: config, SQLite session store, transcript
 * mirror, engine factory, MCP host, and the adapter used by both the TUI and
 * the web GUI. dispose() is idempotent and mirrors the historical cleanup
 * order (factory → sqlite → transcript mirror → mcp host); resources created
 * before a failure are cleaned up too.
 */
export async function createRunContext(
  project: string | undefined,
  options: { readonly model?: string },
): Promise<RunContext> {
  const cwd = resolve(project ?? process.cwd())
  await initWrenConfig(undefined, cwd)

  const mcpHost = new WorkspaceMcpHost()
  let sqliteStore: ReturnType<typeof createSqliteSessionStore> | undefined
  let factory: Awaited<ReturnType<typeof createWrenEngineFactory>> | undefined
  let disposed = false

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      if (factory !== undefined) await factory.dispose()
    } finally {
      try {
        sqliteStore?.close()
      } finally {
        closeTranscriptMirror()
        await mcpHost.dispose()
      }
    }
  }

  try {
    sqliteStore = createSqliteSessionStore(dbPath())
    // Transcript mirror: the engine_* tables in the same sessions.db are the
    // storage of record for the vendored engine's transcript stream. Every
    // JSONL entry is mirrored here, JSONL file writes are disabled (the
    // engine's in-memory dedup/chain logic is unaffected — only file I/O is
    // cut), and subagent reads (getAgentTranscript, agent metadata) go
    // SQLite-first with JSONL fallback for pre-migration data.
    initTranscriptMirror(dbPath())
    setEntryMirror(mirrorEntryToSqlite)
    setTranscriptFileSink(async () => {})
    factory = await createWrenEngineFactory(
      options.model !== undefined
        ? { cwd, model: options.model, mcpSnapshotProvider: () => mcpHost.getSnapshot() }
        : { cwd, mcpSnapshotProvider: () => mcpHost.getSnapshot() },
    )
    const engineFactory = factory
    await mcpHost.start()
    const resolvedModel = options.model ?? engineFactory.getDefaultModel()
    const placeholderHistoryOwner = {}
    const placeholderEngine: WrenEngine = {
      submitMessage: () => {
        throw new Error("use factory")
      },
      interrupt: () => {},
      resetAbortController: () => {},
      getModel: () => engineFactory.getDefaultModel(),
      setModel: () => {},
      setPermissionResolver: () => {},
      getMessages: () => [],
      truncateMessages: () => {},
      snapshotHistory: () => EngineHistorySnapshot.capture(placeholderHistoryOwner, [], () => {}),
      restoreHistory: (snapshot) => snapshot.restoreFor(placeholderHistoryOwner),
      dispose: () => {},
    }
    const adapter = createWrenAdapter(placeholderEngine, {
      sessionStore: sqliteStore,
      engineFactory: factory,
      cwd,
      restoreEngineMessages: async (sessionId) => {
        const restored = await loadEngineSessionMessages(sessionId)
        if (restored === null) return null
        return {
          engineSessionId: sessionId,
          messages: restored.messages,
          ...(restored.goalState !== undefined && { goalState: restored.goalState }),
        }
      },
    })
    await adapter.resume()
    return { cwd, adapter, resolvedModel, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

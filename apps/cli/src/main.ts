#!/usr/bin/env bun
import { join, resolve } from "node:path"
import type { WrenAdapter } from "@wren/adapter"
import { createWrenAdapter, createWrenRequest } from "@wren/adapter"
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
import { getWrenConfigHome } from "@wren/config-node"
import {
  parseSessionId,
  type Session,
  type SessionId,
  SessionSchema,
} from "@wren/protocol"
import { createSqliteSessionStore } from "@wren/storage"
import { runTui } from "@wren/tui"
import { type CliOptions, createCliProgram } from "./cli-command"
import { initWrenConfig } from "./configInit"

export type NonInteractiveArgs = {
  readonly prompt: string
  readonly modelId: string
  readonly sessionId: string | undefined
  readonly continueSession: boolean
  readonly auto: boolean
}

class CliUsageError extends Error {
  readonly name = "CliUsageError"
}

let terminalSessionActive = false

function dbPath(): string {
  return join(getWrenConfigHome(), "sessions.db")
}

async function listSessions(adapter: WrenAdapter): Promise<Session[]> {
  const response = await adapter.fetch(createWrenRequest(`/session`))
  return SessionSchema.array().parse(await response.json())
}

function selectSession(
  sessions: readonly Session[],
  sessionId: string | undefined,
  continueSession: boolean,
): Session | undefined {
  if (sessionId !== undefined) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found === undefined) {
      throw new CliUsageError(`session not found: ${sessionId}`)
    }
    return found
  }
  if (!continueSession) return undefined
  const mostRecent = sessions[0]
  if (mostRecent === undefined) {
    throw new CliUsageError("no previous session to continue")
  }
  return mostRecent
}

async function createSession(
  adapter: WrenAdapter,
  cwd: string,
  auto: boolean,
  modelId: string,
): Promise<Session> {
  const response = await adapter.fetch(
    createWrenRequest(`/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, permissionMode: auto ? "auto" : "default", modelId }),
    }),
  )
  return SessionSchema.parse(await response.json())
}

async function setSessionPermissionMode(
  adapter: WrenAdapter,
  sessionId: SessionId,
  permissionMode: string,
): Promise<void> {
  await adapter.fetch(
    createWrenRequest(`/session/${sessionId}/permission-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissionMode }),
    }),
  )
}

async function sendPrompt(
  adapter: WrenAdapter,
  sessionId: SessionId,
  prompt: string,
  disableGoalContinuation = false,
): Promise<void> {
  const response = await adapter.fetch(
    createWrenRequest(`/session/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        ...(disableGoalContinuation && { disableGoalContinuation: true }),
      }),
    }),
  )
  if (!response.ok) {
    const status =
      response.statusText === ""
        ? `${response.status}`
        : `${response.status} ${response.statusText}`
    throw new Error(`prompt failed: ${status}`)
  }
  await adapter.waitForIdle(sessionId)
}

function extractAssistantText(
  adapter: WrenAdapter,
  sessionId: SessionId,
  messageIdsBeforePrompt: ReadonlySet<string>,
): string {
  const bundle = adapter.state.getBundle(sessionId)
  if (bundle === undefined) return ""
  const lines: string[] = []
  for (const msg of bundle.messages) {
    if (messageIdsBeforePrompt.has(msg.id) || msg.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type === "text") {
        lines.push(part.text)
      }
    }
  }
  return lines.join("\n")
}

export async function runNonInteractive(
  adapter: WrenAdapter,
  cwd: string,
  args: NonInteractiveArgs,
  runtime: { readonly setExitCode: (code: number) => void } = {
    setExitCode: (code) => {
      process.exitCode = code
    },
  },
): Promise<string> {
  const existing = await listSessions(adapter)
  const requested = selectSession(existing, args.sessionId, args.continueSession)
  const session = requested ?? (await createSession(adapter, cwd, args.auto, args.modelId))
  if (requested !== undefined) {
    await setSessionPermissionMode(adapter, requested.id, args.auto ? "auto" : "default")
    // Load existing messages into the store so persistSession doesn't overwrite
    // the full history with only the new prompt + response.
    const messagesRes = await adapter.fetch(createWrenRequest(`/session/${requested.id}/messages`))
    if (!messagesRes.ok) {
      throw new Error(`Failed to load session messages: ${messagesRes.status}`)
    }
  }
  const messageIdsBeforePrompt = new Set(
    adapter.state.getBundle(session.id)?.messages.map((message) => message.id) ?? [],
  )
  await sendPrompt(adapter, session.id, args.prompt, true)
  if (adapter.getLastRunFailed(session.id)) {
    runtime.setExitCode(1)
  }
  return extractAssistantText(adapter, session.id, messageIdsBeforePrompt)
}

async function runWren(project: string | undefined, options: CliOptions): Promise<void> {
  const cwd = resolve(project ?? process.cwd())

  await initWrenConfig(undefined, cwd)

  let nonInteractive = false
  const mcpHost = new WorkspaceMcpHost()
  try {
    const sqliteStore = createSqliteSessionStore(dbPath())
    // Transcript mirror: the engine_* tables in the same sessions.db are the
    // storage of record for the vendored engine's transcript stream. Every
    // JSONL entry is mirrored here, JSONL file writes are disabled (the
    // engine's in-memory dedup/chain logic is unaffected — only file I/O is
    // cut), and subagent reads (getAgentTranscript, agent metadata) go
    // SQLite-first with JSONL fallback for pre-migration data.
    initTranscriptMirror(dbPath())
    setEntryMirror(mirrorEntryToSqlite)
    setTranscriptFileSink(async () => {})
    try {
      const cliModel = options.model
      const factory = await createWrenEngineFactory(
        cliModel !== undefined
          ? { cwd, model: cliModel, mcpSnapshotProvider: () => mcpHost.getSnapshot() }
          : { cwd, mcpSnapshotProvider: () => mcpHost.getSnapshot() },
      )
      await mcpHost.start()
      try {
        const resolvedModel = cliModel ?? factory.getDefaultModel()
        const placeholderHistoryOwner = {}
        const placeholderEngine: WrenEngine = {
          submitMessage: () => {
            throw new Error("use factory")
          },
          interrupt: () => {},
          resetAbortController: () => {},
          getModel: () => factory.getDefaultModel(),
          setModel: () => {},
          setPermissionResolver: () => {},
          getMessages: () => [],
          truncateMessages: () => {},
          snapshotHistory: () =>
            EngineHistorySnapshot.capture(placeholderHistoryOwner, [], () => {}),
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

        if (options.prompt !== undefined) {
          const output = await runNonInteractive(adapter, cwd, {
            prompt: options.prompt,
            modelId: resolvedModel,
            sessionId: options.session,
            continueSession: options.continue === true,
            auto: options.auto ?? true,
          })
          if (output.length > 0) console.log(output)
          nonInteractive = true
          return
        }

        const existing = await listSessions(adapter)
        const requested = selectSession(existing, options.session, options.continue === true)
        const permissionMode = options.auto === false ? "default" : "auto"
        if (requested !== undefined) {
          await setSessionPermissionMode(adapter, requested.id, permissionMode)
        }
        const tuiOptions = {
          initialCwd: cwd,
          initialModel: resolvedModel,
          ...(requested !== undefined && {
            initialRoute: { type: "session" as const, sessionId: parseSessionId(requested.id) },
          }),
        }

        const engineState = (await import("@wren/engine")) as unknown as {
          setIsInteractive(value: boolean): void
        }
        engineState.setIsInteractive(true)
        terminalSessionActive = true
        const renderer = await runTui(adapter, tuiOptions)
        await new Promise<void>((resolve) => {
          renderer.on("destroy", () => resolve())
        })
      } finally {
        factory.dispose()
      }
    } finally {
      sqliteStore.close()
      closeTranscriptMirror()
    }
  } finally {
    await mcpHost.dispose()
    if (nonInteractive) {
      process.exit(0)
    }
  }
}

export async function runCli(rawArgs: readonly string[]): Promise<void> {
  await createCliProgram(runWren).parseAsync(rawArgs, { from: "user" })
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2))
}

function restoreTerminal(): void {
  if (!terminalSessionActive) return
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l")
  process.stdout.write("\x1b[?25h")
  process.stdout.write("\x1b[?1049l")
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false)
  }
}

function handleFatal(error: unknown): void {
  restoreTerminal()
  if (error instanceof CliUsageError) {
    console.error(error.message)
    process.exitCode = 2
    return
  }
  if (error instanceof Error) {
    console.error(error.stack ?? error.message)
    process.exitCode = 1
    return
  }
  console.error(String(error))
  process.exitCode = 1
}

process.on("exit", restoreTerminal)

// During the TUI phase, @opentui/core installs its own signal handlers that
// destroy the renderer, which resolves runWren's destroy promise so session
// cleanup (SQLite flush, MCP/LSP shutdown) runs before exit. Registering our
// own SIGTERM/SIGHUP handlers here would preempt that with process.exit(0)
// and skip the cleanup chain — so we deliberately do not.

// Async rejections bypass handleFatal (which only covers main()'s promise);
// without these the terminal can be left in raw mode with a dead cursor.
process.on("unhandledRejection", (reason) => {
  handleFatal(reason)
})
process.on("uncaughtException", (error) => {
  handleFatal(error)
  // Process state is undefined after an uncaught exception — exit rather
  // than continuing with possibly-broken state.
  process.exit(1)
})

if (import.meta.main) {
  void main().catch(handleFatal)
}

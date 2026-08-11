#!/usr/bin/env bun
/**
 * Repair a session's legacy adapter snapshot (session/message/part/todo/
 * permission rows) when it is missing part of its conversation.
 *
 * Why this happens: migration v11 dropped the engine_snapshot column and
 * engine_session_state from the session table. Any app process started BEFORE
 * that migration still runs code that references them, so its persistSession
 * ("no such column: engine_snapshot") and its transcript mirror writes
 * ("no such table: engine_session_state") fail from the migration on — the
 * legacy snapshot freezes at the last successful save while engine_event
 * keeps whatever the mirror managed to record. On reopen, the TUI shows the
 * frozen history.
 *
 * The repair rebuilds the session's display messages from engine_event (the
 * authoritative log) by replaying the entries through the production SDK
 * message mapper with per-entry timestamps, then persists the bundle.
 * Session metadata (cwd/model/title/permissionMode) is preserved from the
 * existing legacy row; status is reset to idle.
 *
 * --full rebuilds the ENTIRE message list from engine_event (fixes gaps
 * anywhere in the timeline). Without it, only entries newer than the
 * snapshot's last message are appended.
 *
 * Run with ALL wren instances closed (a live instance overwrites the legacy
 * rows on its next save).
 *
 * Usage:
 *   bun run scripts/repair-legacy-snapshots.ts [--full] [dbPath] <sessionId ...>
 */
import { basename, join } from "node:path"
import { getWrenConfigHome } from "@wren/config-node"
import { createEngineTranscriptStore, createSqliteSessionStore } from "@wren/storage"
import { consumeSDKMessageStream, type SDKMessage, type TuiStoreApi } from "@wren/adapter"
import type {
  Diff,
  Message,
  Part,
  PermissionRequest,
  Session,
  SessionId,
  SnapshotFileDiff,
  Status,
  Todo,
} from "@wren/protocol"

/**
 * Minimal non-reactive store for the full replay. The real TuiStoreApi
 * rebuilds its messages array per insert (O(n²) for a 40k-message session);
 * this plain store keeps arrays and implements only the members the mapper
 * touches. The final bundle is saved by the caller.
 */
function createPlainStore(session: Session): { store: TuiStoreApi; bundle: () => SessionBundleLike } {
  const state = {
    session,
    status: { type: "idle" as const },
    messages: [] as Message[],
    todos: [] as Todo[],
    permissions: [] as PermissionRequest[],
    questions: [] as unknown[],
    diffFiles: [] as SnapshotFileDiff[],
  }
  const findMessage = (id: Message["id"]): Message | undefined =>
    state.messages.find((m) => m.id === id)
  const store = {
    addMessage: (message: Message) => {
      state.messages.push(message)
    },
    addMessageBeforeQueued: (message: Message) => {
      state.messages.push(message)
    },
    replaceMessage: (_sid: SessionId, id: Message["id"], msg: Message) => {
      const idx = state.messages.findIndex((m) => m.id === id)
      if (idx >= 0) state.messages[idx] = msg
    },
    addPart: (_sid: SessionId, messageId: Message["id"], part: Part) => {
      findMessage(messageId)?.parts.push(part)
    },
    updatePart: (
      _sid: SessionId,
      messageId: Message["id"],
      partId: Part["id"],
      updater: (p: Part) => Part,
    ) => {
      const message = findMessage(messageId)
      if (!message) return
      const idx = message.parts.findIndex((p) => p.id === partId)
      if (idx >= 0) message.parts[idx] = updater(message.parts[idx]!)
    },
    appendPartText: (_sid: SessionId, messageId: Message["id"], partId: Part["id"], delta: string) => {
      const part = findMessage(messageId)?.parts.find((p) => p.id === partId)
      if (part && part.type === "text") part.text += delta
    },
    setStatus: (_sid: SessionId, status: Status) => {
      state.status = status
    },
    setTodos: (_sid: SessionId, todos: Todo[]) => {
      state.todos = todos
    },
    setDiff: (diff: Diff) => {
      state.diffFiles = diff.files
    },
    restoreConversation: (
      _sid: SessionId,
      snapshot: {
        messages: Message[]
        todos: Todo[]
        status: Status
        diff: Diff
        permissions: PermissionRequest[]
        questions: unknown[]
        permissionMode: string
      },
    ) => {
      state.messages = snapshot.messages
      state.todos = snapshot.todos
      state.status = snapshot.status
      state.diffFiles = snapshot.diff.files
      state.permissions = snapshot.permissions
      state.questions = snapshot.questions
    },
    getBundle: () => ({
      session: state.session,
      status: state.status,
      messages: state.messages,
      todos: state.todos,
      permissions: state.permissions,
      questions: state.questions,
      diff: state.diffFiles,
    }),
  } as unknown as TuiStoreApi
  return {
    store,
    bundle: () => ({
      session: state.session,
      status: state.status,
      messages: state.messages,
      todos: state.todos,
      permissions: state.permissions,
      diff: state.diffFiles,
    }),
  }
}

type SessionBundleLike = {
  session: Session
  status: Status
  messages: Message[]
  todos: Todo[]
  permissions: PermissionRequest[]
  diff: SnapshotFileDiff[]
}

const args = process.argv.slice(2)
const full = args.includes("--full")
const positional = args.filter((a) => !a.startsWith("--"))
const dbPath = positional[0] ?? join(getWrenConfigHome(), "sessions.db")
const sessionIds = positional.slice(1)

if (sessionIds.length === 0) {
  console.error("usage: repair-legacy-snapshots.ts [--full] [dbPath] <sessionId ...>")
  process.exit(1)
}

const sessionStore = createSqliteSessionStore(dbPath)
const engineStore = createEngineTranscriptStore(dbPath)

function mainStreamEntries(
  events: readonly { payload: unknown }[],
): (Record<string, unknown> & { type?: unknown; timestamp?: unknown })[] {
  return events
    .map((event) => event.payload)
    .filter((payload): payload is Record<string, unknown> & { type?: unknown } =>
      typeof payload === "object" && payload !== null,
    )
    .filter(
      (payload) =>
        (payload as { isSidechain?: unknown }).isSidechain !== true &&
        (payload as { agentId?: unknown }).agentId === undefined,
    )
}

for (const sessionId of sessionIds) {
  const loaded = await sessionStore.load(sessionId)
  if (!loaded.ok) {
    console.error(`skip ${sessionId}: ${loaded.error.kind} — not in legacy snapshot`)
    continue
  }
  const bundle = loaded.value
  const legacyMessages = bundle.messages
  const lastCreatedAt = legacyMessages.at(-1)?.createdAt ?? ""
  const events = await engineStore.events(sessionId)
  const entries = mainStreamEntries(events)

  // engine_event id order is NOT chronological: the one-time JSONL backfill
  // appended older (pre-Aug-6) entries after the live mirror's newer ones.
  // Sort by timestamp so the replay matches the real timeline.
  const chronological = [...entries].sort((a, b) => {
    const ta = typeof a.timestamp === "string" ? a.timestamp : "9999-12-31T23:59:59.999Z"
    const tb = typeof b.timestamp === "string" ? b.timestamp : "9999-12-31T23:59:59.999Z"
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })

  const replay =
    full
      ? chronological
      : chronological.filter(
          (entry) =>
            typeof entry.timestamp === "string" && entry.timestamp > lastCreatedAt,
        )
  console.log(
    `session ${basename(sessionId)}: legacy messages=${legacyMessages.length} ` +
      `last=${lastCreatedAt.slice(11, 19)}Z engine entries=${entries.length} ` +
      `replay=${replay.length}${full ? " (full)" : ""}`,
  )
  if (replay.length === 0) {
    console.log("  nothing to repair")
    continue
  }

  const plain = createPlainStore({ ...bundle.session, id: sessionId as SessionId })
  const tui = plain.store
  if (!full) {
    tui.restoreConversation(sessionId as SessionId, {
      messages: bundle.messages,
      todos: bundle.todos,
      status: bundle.status,
      diff: {
        sessionId: sessionId as SessionId,
        files: bundle.diff,
        updatedAt: bundle.messages.at(-1)?.createdAt ?? "",
      },
      permissionMode: bundle.session.permissionMode,
      permissions: [],
      questions: [],
    })
  }

  // The mapper stamps createdAt via clock.now(); hand each entry's own
  // timestamp over so the rebuilt messages keep their original times.
  let currentTimestamp = full ? "2026-01-01T00:00:00.000Z" : lastCreatedAt
  let replayed = 0
  async function* replayStream(): AsyncGenerator<SDKMessage, void, unknown> {
    for (const entry of replay) {
      if (typeof entry.timestamp === "string") currentTimestamp = entry.timestamp
      replayed++
      if (replayed % 5000 === 0) console.error(`  ...${replayed}/${replay.length} entries`)
      // The transcript holds final messages only. The mapper's streaming
      // state treats a final assistant message as a delta of the previous
      // one unless message_start opened it — synthesize the start so each
      // entry becomes its own message, exactly like the live stream did.
      if (entry.type === "assistant") {
        const id = (entry.message as { id?: unknown } | undefined)?.id
        if (typeof id === "string") {
          yield {
            type: "stream_event",
            event: { type: "message_start", message: { id } },
          } as unknown as SDKMessage
        }
      }
      yield entry as unknown as SDKMessage
    }
  }
  const clock = { now: () => currentTimestamp }

  const result = await consumeSDKMessageStream(replayStream(), {
    sessionId: sessionId as SessionId,
    store: tui,
    clock,
  })
  if (!result.ok) {
    console.error(`  replay failed: ${result.message}`)
    continue
  }

  const repairedBundle = { ...plain.bundle(), status: { type: "idle" as const } }
  const added = repairedBundle.messages.length - legacyMessages.length
  await sessionStore.save(repairedBundle)
  console.log(`  repaired: messages now ${repairedBundle.messages.length} (+${added})`)
}

sessionStore.close()
engineStore.close()

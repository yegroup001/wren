import type { Database } from "bun:sqlite"
import type {
  Message,
  Part,
  PermissionRequest,
  Result,
  Session,
  SessionBundle,
  SessionPreview,
  SnapshotFileDiff,
  Status,
  Todo,
} from "@wren/protocol"
import {
  err,
  type MessageId,
  ok,
  parsePermissionId,
  SessionBundleSchema,
  type SessionId,
} from "@wren/protocol"
import { initDatabase } from "./db"
import type {
  SessionMetaUpdate,
  SessionStore,
  SessionStoreList,
  SessionStoreSummaryList,
  SkippedSession,
  StorageLoadError,
} from "./index"

type SessionRow = {
  id: string
  cwd: string
  model_id: string
  model_ref: string | null
  permission_mode: string
  effort: string | null
  title: string | null
  status: string
  diff: string
  time_created: string
  time_updated: string
}

type MessageRow = {
  id: string
  session_id: string
  role: string
  created_at: string
  error: string | null
}

type PartRow = {
  id: string
  message_id: string
  session_id: string
  type: string
  data: string
}

type TodoRow = {
  id: string
  session_id: string
  status: string
  content: string
}

type PermissionRow = {
  id: string
  session_id: string
  tool_name: string
  display_type: string
  input: string
}

export function createSqliteSessionStore(dbPath: string): SessionStore {
  const db = initDatabase(dbPath)
  return new SqliteSessionStore(db)
}

class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  async save(bundle: SessionBundle): Promise<void> {
    const now = new Date().toISOString()
    const firstMsg = bundle.messages[0]
    const lastMsg = bundle.messages[bundle.messages.length - 1]
    const timeCreated = firstMsg?.createdAt ?? now
    const timeUpdated = lastMsg?.createdAt ?? now

    const title = (bundle.session as Session & { title?: string }).title ?? null
    const modelRef = bundle.session.modelRef ? JSON.stringify(bundle.session.modelRef) : null

    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO session (id, cwd, model_id, model_ref, permission_mode, effort, title, status, diff, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            cwd=excluded.cwd, model_id=excluded.model_id, model_ref=excluded.model_ref, permission_mode=excluded.permission_mode,
           effort=excluded.effort, title=excluded.title, status=excluded.status, diff=excluded.diff,
           time_updated=excluded.time_updated`,
        [
          bundle.session.id,
          bundle.session.cwd,
          bundle.session.modelId,
          modelRef,
          bundle.session.permissionMode,
          bundle.session.effort ?? null,
          title,
          JSON.stringify(bundle.status),
          JSON.stringify(bundle.diff),
          timeCreated,
          timeUpdated,
        ],
      )

      this.db.run("DELETE FROM message WHERE session_id = ?", [bundle.session.id])

      for (const msg of bundle.messages) {
        this.db.run(
          `INSERT OR REPLACE INTO message (id, session_id, role, created_at, error, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [msg.id, msg.sessionId, msg.role, msg.createdAt, msg.error ?? null, msg.createdAt, now],
        )
        for (const part of msg.parts) {
          this.db.run(
            `INSERT OR REPLACE INTO part (id, message_id, session_id, type, data, time_created, time_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [part.id, msg.id, msg.sessionId, part.type, JSON.stringify(part), now, now],
          )
        }
      }

      this.db.run("DELETE FROM todo WHERE session_id = ?", [bundle.session.id])
      for (const todo of bundle.todos) {
        this.db.run(
          `INSERT OR REPLACE INTO todo (id, session_id, status, content, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`,
          [todo.id, todo.sessionId, todo.status, todo.content, now, now],
        )
      }

      this.db.run("DELETE FROM permission WHERE session_id = ?", [bundle.session.id])
      for (const perm of bundle.permissions) {
        this.db.run(
          `INSERT OR REPLACE INTO permission (id, session_id, tool_name, display_type, input, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            perm.id,
            perm.sessionId,
            perm.toolName,
            perm.displayType,
            JSON.stringify(perm.input),
            now,
            now,
          ],
        )
      }
    })
    tx()
  }

  async saveSessionMeta(meta: SessionMetaUpdate): Promise<void> {
    const now = new Date().toISOString()
    const title = (meta.session as Session & { title?: string }).title ?? null
    this.db.run(
      `UPDATE session SET
         cwd = ?, model_id = ?, model_ref = ?, permission_mode = ?, effort = ?, title = ?,
         status = ?, diff = ?, time_updated = ?
       WHERE id = ?`,
      [
        meta.session.cwd,
        meta.session.modelId,
        meta.session.modelRef ? JSON.stringify(meta.session.modelRef) : null,
        meta.session.permissionMode,
        meta.session.effort ?? null,
        title,
        JSON.stringify(meta.status),
        JSON.stringify(meta.diff),
        now,
        meta.session.id,
      ],
    )
  }

  async load(sessionId: string): Promise<Result<SessionBundle, StorageLoadError>> {
    const sessionRow = this.db
      .query("SELECT * FROM session WHERE id = ?")
      .get(sessionId) as SessionRow | null

    if (sessionRow === null) {
      return err({ kind: "not_found", sessionId })
    }

    try {
      return ok(this.assembleBundle(sessionRow))
    } catch (error) {
      return err({
        kind: "corrupted",
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async list(cwd?: string): Promise<SessionStoreList> {
    const sessionRows =
      cwd !== undefined
        ? (this.db
            .query("SELECT * FROM session WHERE cwd = ? ORDER BY time_updated DESC")
            .all(cwd) as SessionRow[])
        : (this.db.query("SELECT * FROM session ORDER BY time_updated DESC").all() as SessionRow[])

    if (sessionRows.length === 0) {
      return { bundles: [], skipped: [] }
    }

    const ids = sessionRows.map((s) => s.id)
    const placeholders = ids.map(() => "?").join(",")

    const messageRows = this.db
      .query(
        `SELECT * FROM message WHERE session_id IN (${placeholders}) ORDER BY session_id, created_at`,
      )
      .all(...ids) as MessageRow[]

    const partRows = this.db
      .query(
        `SELECT * FROM part WHERE session_id IN (${placeholders}) ORDER BY session_id, message_id, rowid`,
      )
      .all(...ids) as PartRow[]

    const todoRows = this.db
      .query(`SELECT * FROM todo WHERE session_id IN (${placeholders})`)
      .all(...ids) as TodoRow[]

    const permissionRows = this.db
      .query(`SELECT * FROM permission WHERE session_id IN (${placeholders})`)
      .all(...ids) as PermissionRow[]

    const messagesBySession = groupBy(messageRows, (r) => r.session_id)
    const partsByMessage = groupBy(partRows, (r) => r.message_id)
    const todosBySession = groupBy(todoRows, (r) => r.session_id)
    const permissionsBySession = groupBy(permissionRows, (r) => r.session_id)

    const bundles: SessionBundle[] = []
    const skipped: SkippedSession[] = []

    for (const sessionRow of sessionRows) {
      try {
        const sid = sessionRow.id
        const messages = (messagesBySession.get(sid) ?? []).map((mr) => {
          const parts = (partsByMessage.get(mr.id) ?? []).map((pr) => JSON.parse(pr.data) as Part)
          const msg: Message = {
            id: mr.id as MessageId,
            sessionId: sid as SessionId,
            role: mr.role as Message["role"],
            parts,
            createdAt: mr.created_at,
            ...(mr.error !== null && { error: mr.error }),
          }
          return msg
        })

        const todos = (todosBySession.get(sid) ?? []).map((tr) => ({
          id: tr.id,
          sessionId: sid as SessionId,
          status: tr.status as Todo["status"],
          content: tr.content,
        }))

        const permissions = (permissionsBySession.get(sid) ?? []).map((pr) => ({
          id: parsePermissionId(pr.id),
          sessionId: sid as SessionId,
          toolName: pr.tool_name,
          displayType: pr.display_type as PermissionRequest["displayType"],
          input: JSON.parse(pr.input),
        }))

        const diff = JSON.parse(sessionRow.diff) as SnapshotFileDiff[]
        const status = JSON.parse(sessionRow.status) as Status
        const modelRef = parseModelRef(sessionRow.model_ref)

        const session: Session & { title?: string } = {
          id: sessionRow.id as SessionId,
          cwd: sessionRow.cwd,
          modelId: sessionRow.model_id,
          ...(modelRef !== undefined && { modelRef }),
          permissionMode: sessionRow.permission_mode,
          ...(sessionRow.effort !== null &&
            sessionRow.effort !== "" && { effort: sessionRow.effort as Session["effort"] }),
          ...(sessionRow.title !== null && sessionRow.title !== "" && { title: sessionRow.title }),
        }

        const bundle: SessionBundle = {
          session,
          status,
          messages,
          todos,
          permissions,
          diff,
        }

        const parsed = SessionBundleSchema.parse(bundle)
        if (sessionRow.title !== null && sessionRow.title !== "") {
          ;(parsed.session as { title?: string }).title = sessionRow.title
        }
        bundles.push(parsed)
      } catch (error) {
        skipped.push({
          sessionId: sessionRow.id,
          path: sessionRow.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { bundles, skipped }
  }

  async listSummaries(cwd?: string): Promise<SessionStoreSummaryList> {
    const sessionRows =
      cwd !== undefined
        ? (this.db
            .query("SELECT * FROM session WHERE cwd = ? ORDER BY time_updated DESC")
            .all(cwd) as SessionRow[])
        : (this.db.query("SELECT * FROM session ORDER BY time_updated DESC").all() as SessionRow[])

    if (sessionRows.length === 0) {
      return { bundles: [], skipped: [] }
    }

    const ids = sessionRows.map((s) => s.id)
    const placeholders = ids.map(() => "?").join(",")

    const todoRows = this.db
      .query(`SELECT * FROM todo WHERE session_id IN (${placeholders})`)
      .all(...ids) as TodoRow[]

    const previewRows = this.db
      .query(
        `SELECT m1.* FROM message m1
         INNER JOIN (
           SELECT session_id, MIN(created_at) AS min_created
           FROM message WHERE role = 'user' GROUP BY session_id
         ) m2 ON m1.session_id = m2.session_id AND m1.created_at = m2.min_created
         WHERE m1.session_id IN (${placeholders})`,
      )
      .all(...ids) as MessageRow[]

    const previewMessageIds = previewRows.map((r) => r.id)
    const msgPlaceholders = previewMessageIds.map(() => "?").join(",")
    const partRows =
      previewMessageIds.length > 0
        ? (this.db
            .query(`SELECT * FROM part WHERE message_id IN (${msgPlaceholders}) ORDER BY rowid`)
            .all(...previewMessageIds) as PartRow[])
        : []

    const todosBySession = groupBy(todoRows, (r) => r.session_id)
    const previewBySession = new Map<string, MessageRow>()
    for (const row of previewRows) {
      if (!previewBySession.has(row.session_id)) {
        previewBySession.set(row.session_id, row)
      }
    }
    const partsByMessage = groupBy(partRows, (r) => r.message_id)

    const bundles: SessionStoreSummaryList["bundles"][number][] = []
    const skipped: SkippedSession[] = []

    for (const sessionRow of sessionRows) {
      try {
        const sid = sessionRow.id
        const todos = (todosBySession.get(sid) ?? []).map((tr) => ({
          id: tr.id,
          sessionId: sid as SessionId,
          status: tr.status as Todo["status"],
          content: tr.content,
        }))

        const previewMsg = previewBySession.get(sid)
        const previewParts =
          previewMsg === undefined
            ? []
            : (partsByMessage.get(previewMsg.id) ?? []).map((pr) => JSON.parse(pr.data) as Part)
        const previewText = previewParts.find((part) => part.type === "text")
        const preview: SessionPreview | undefined =
          previewMsg !== undefined && previewText !== undefined
            ? { createdAt: sessionRow.time_updated, text: previewText.text }
            : undefined

        const diff = JSON.parse(sessionRow.diff) as SnapshotFileDiff[]
        const status = JSON.parse(sessionRow.status) as Status
        const modelRef = parseModelRef(sessionRow.model_ref)

        const session: Session & { title?: string } = {
          id: sessionRow.id as SessionId,
          cwd: sessionRow.cwd,
          modelId: sessionRow.model_id,
          ...(modelRef !== undefined && { modelRef }),
          permissionMode: sessionRow.permission_mode,
          ...(sessionRow.effort !== null &&
            sessionRow.effort !== "" && { effort: sessionRow.effort as Session["effort"] }),
          ...(sessionRow.title !== null && sessionRow.title !== "" && { title: sessionRow.title }),
        }

        const bundle: SessionBundle = {
          session,
          status,
          messages: [],
          todos,
          permissions: [],
          diff,
        }

        const parsed = SessionBundleSchema.parse(bundle)
        if (sessionRow.title !== null && sessionRow.title !== "") {
          ;(parsed.session as { title?: string }).title = sessionRow.title
        }
        const { messages: _messages, ...summary } = parsed
        bundles.push({
          ...summary,
          ...(preview !== undefined && { preview }),
        })
      } catch (error) {
        skipped.push({
          sessionId: sessionRow.id,
          path: sessionRow.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { bundles, skipped }
  }

  async delete(sessionId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM engine_session WHERE id = ?", [sessionId])
      this.db.run("DELETE FROM session WHERE id = ?", [sessionId])
    })
    tx()
  }

  async messageCount(sessionId: string): Promise<number> {
    const row = this.db
      .query("SELECT count(*) as c FROM message WHERE session_id = ?")
      .get(sessionId) as { c: number } | undefined
    return row?.c ?? 0
  }

  close(): void {
    this.db.close()
  }

  private assembleBundle(sessionRow: SessionRow): SessionBundle {
    const sid = sessionRow.id

    const messageRows = this.db
      .query("SELECT * FROM message WHERE session_id = ? ORDER BY created_at")
      .all(sid) as MessageRow[]

    const partRows = this.db
      .query("SELECT * FROM part WHERE session_id = ? ORDER BY message_id, rowid")
      .all(sid) as PartRow[]

    const todoRows = this.db.query("SELECT * FROM todo WHERE session_id = ?").all(sid) as TodoRow[]

    const permissionRows = this.db
      .query("SELECT * FROM permission WHERE session_id = ?")
      .all(sid) as PermissionRow[]

    const partsByMessage = groupBy(partRows, (r) => r.message_id)

    const messages: Message[] = messageRows.map((mr) => {
      const parts = (partsByMessage.get(mr.id) ?? []).map((pr) => JSON.parse(pr.data) as Part)
      const msg: Message = {
        id: mr.id as MessageId,
        sessionId: sid as SessionId,
        role: mr.role as Message["role"],
        parts,
        createdAt: mr.created_at,
        ...(mr.error !== null && { error: mr.error }),
      }
      return msg
    })

    const todos: Todo[] = todoRows.map((tr) => ({
      id: tr.id,
      sessionId: sid as SessionId,
      status: tr.status as Todo["status"],
      content: tr.content,
    }))

    const permissions: PermissionRequest[] = permissionRows.map((pr) => ({
      id: parsePermissionId(pr.id),
      sessionId: sid as SessionId,
      toolName: pr.tool_name,
      displayType: pr.display_type as PermissionRequest["displayType"],
      input: JSON.parse(pr.input),
    }))

    const diff = JSON.parse(sessionRow.diff) as SnapshotFileDiff[]
    const status = JSON.parse(sessionRow.status) as Status
    const modelRef = parseModelRef(sessionRow.model_ref)

    const session: Session & { title?: string } = {
      id: sessionRow.id as SessionId,
      cwd: sessionRow.cwd,
      modelId: sessionRow.model_id,
      ...(modelRef !== undefined && { modelRef }),
      permissionMode: sessionRow.permission_mode,
      ...(sessionRow.effort !== null &&
        sessionRow.effort !== "" && { effort: sessionRow.effort as Session["effort"] }),
      ...(sessionRow.title !== null && sessionRow.title !== "" && { title: sessionRow.title }),
    }

    const bundle: SessionBundle = {
      session,
      status,
      messages,
      todos,
      permissions,
      diff,
    }

    const parsed = SessionBundleSchema.parse(bundle)
    if (sessionRow.title !== null && sessionRow.title !== "") {
      ;(parsed.session as { title?: string }).title = sessionRow.title
    }
    return parsed
  }
}

function groupBy<T, K>(arr: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of arr) {
    const key = keyFn(item)
    const existing = map.get(key)
    if (existing !== undefined) {
      existing.push(item)
    } else {
      map.set(key, [item])
    }
  }
  return map
}

function parseModelRef(value: string | null): Session["modelRef"] {
  return value === null ? undefined : (JSON.parse(value) as Session["modelRef"])
}

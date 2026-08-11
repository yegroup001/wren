import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import type { EngineStreamRef } from "./engine-transcript-types"

type IdRow = { readonly id: string }

export class EngineSessionRepository {
  constructor(private readonly db: Database) {}

  streamId(sessionId: string, stream: EngineStreamRef): string | undefined {
    return this.db
      .query<IdRow, [string, string | null]>(
        "SELECT id FROM engine_stream WHERE session_id = ? AND agent_id IS ?",
      )
      .get(sessionId, stream.agentId ?? null)?.id
  }

  ensureSession(sessionId: string, projectPath: string, now: string): void {
    this.db.run(
      `INSERT INTO engine_session (id, project_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_path = excluded.project_path,
         updated_at = excluded.updated_at`,
      [sessionId, projectPath, now, now],
    )
  }

  ensureStream(sessionId: string, stream: EngineStreamRef, now: string): string {
    const existing = this.streamId(sessionId, stream)
    if (existing !== undefined) return existing

    const id = randomUUID()
    this.db.run(
      `INSERT INTO engine_stream
       (id, session_id, agent_id, is_sidechain, team_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        stream.agentId ?? null,
        stream.isSidechain ? 1 : 0,
        stream.teamName ?? null,
        now,
        now,
      ],
    )
    return id
  }

  sessionExists(sessionId: string): boolean {
    return (
      this.db
        .query<IdRow, [string]>("SELECT id FROM engine_session WHERE id = ? LIMIT 1")
        .get(sessionId) !== null
    )
  }

  /**
   * Session IDs whose engine_session.updated_at is newer than the given
   * instant. ISO timestamps sort lexicographically, so the comparison is
   * string-based. Equivalent to the old JSONL mtime scan.
   */
  sessionsTouchedSince(projectPath: string, sinceIso: string): string[] {
    return this.db
      .query<IdRow, [string, string]>(
        `SELECT id FROM engine_session
         WHERE project_path = ? AND updated_at > ?
         ORDER BY updated_at DESC`,
      )
      .all(projectPath, sinceIso)
      .map((row) => row.id)
  }

  deleteSession(sessionId: string): void {
    this.db.run("DELETE FROM engine_session WHERE id = ?", [sessionId])
  }
}

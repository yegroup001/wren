import type { Database } from "bun:sqlite"
import type { EngineSessionRepository } from "./engine-session-repository"
import { parseJson } from "./engine-sql"
import type { EngineEvent, EngineEventInput, EngineStreamRef } from "./engine-transcript-types"

type SequenceRow = { readonly sequence: number }
type EventRow = {
  readonly sequence: number
  readonly stream_id: string
  readonly type: string
  readonly timestamp: string | null
  readonly message_uuid: string | null
  readonly parent_uuid: string | null
  readonly is_compact: number
  readonly payload: string
}
type FoundRow = { readonly found: number }

export class EngineEventRepository {
  constructor(
    private readonly db: Database,
    private readonly sessions: EngineSessionRepository,
  ) {}

  append(
    sessionId: string,
    projectPath: string,
    stream: EngineStreamRef,
    events: readonly EngineEventInput[],
  ): readonly EngineEvent[] {
    if (events.length === 0) return []
    const now = new Date().toISOString()
    const appended: EngineEvent[] = []
    this.db.transaction(() => {
      this.sessions.ensureSession(sessionId, projectPath, now)
      const streamId = this.sessions.ensureStream(sessionId, stream, now)
      let sequence =
        this.db
          .query<SequenceRow, [string]>(
            `SELECT COALESCE(MAX(sequence), 0) AS sequence
           FROM engine_event WHERE stream_id = ?`,
          )
          .get(streamId)?.sequence ?? 0
      for (const event of events) {
        sequence++
        this.insertEvent(sessionId, streamId, sequence, event, now)
        appended.push({ ...event, sequence, streamId })
      }
      this.touchSessionAndStream(sessionId, streamId, now)
    })()
    return appended
  }

  events(sessionId: string, stream?: EngineStreamRef): readonly EngineEvent[] {
    const fields = `e.sequence, e.stream_id, e.type, e.timestamp,
      e.message_uuid, e.parent_uuid, e.is_compact, e.payload`
    const rows =
      stream === undefined
        ? this.db
            .query<EventRow, [string]>(
              `SELECT ${fields} FROM engine_event e
             WHERE e.session_id = ? ORDER BY e.id`,
            )
            .all(sessionId)
        : this.db
            .query<EventRow, [string, string | null]>(
              `SELECT ${fields} FROM engine_event e
             INNER JOIN engine_stream s ON s.id = e.stream_id
             WHERE e.session_id = ? AND s.agent_id IS ? ORDER BY e.sequence`,
            )
            .all(sessionId, stream.agentId ?? null)
    return rows.map((row) => ({
      sequence: row.sequence,
      streamId: row.stream_id,
      type: row.type,
      payload: parseJson(row.payload),
      ...(row.timestamp !== null && { timestamp: row.timestamp }),
      ...(row.message_uuid !== null && { messageUuid: row.message_uuid }),
      ...(row.parent_uuid !== null && { parentUuid: row.parent_uuid }),
      ...(row.is_compact === 1 && { isCompact: true }),
    }))
  }

  hasMessage(sessionId: string, messageUuid: string): boolean {
    return (
      this.db
        .query<FoundRow, [string, string]>(
          `SELECT 1 AS found FROM engine_event
         WHERE session_id = ? AND message_uuid = ? LIMIT 1`,
        )
        .get(sessionId, messageUuid) !== null
    )
  }

  messageUuids(sessionId: string): readonly string[] {
    return this.db
      .query<{ readonly message_uuid: string }, [string]>(
        `SELECT message_uuid FROM engine_event
         WHERE session_id = ? AND message_uuid IS NOT NULL`,
      )
      .all(sessionId)
      .map((row) => row.message_uuid)
  }

  private insertEvent(
    sessionId: string,
    streamId: string,
    sequence: number,
    event: EngineEventInput,
    now: string,
  ): void {
    this.db.run(
      `INSERT INTO engine_event
       (session_id, stream_id, sequence, type, timestamp, message_uuid,
        parent_uuid, is_compact, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        streamId,
        sequence,
        event.type,
        event.timestamp ?? null,
        event.messageUuid ?? null,
        event.parentUuid ?? null,
        event.isCompact ? 1 : 0,
        JSON.stringify(event.payload),
        now,
      ],
    )
  }

  private touchSessionAndStream(sessionId: string, streamId: string, now: string): void {
    this.db.run("UPDATE engine_session SET updated_at = ? WHERE id = ?", [now, sessionId])
    this.db.run("UPDATE engine_stream SET updated_at = ? WHERE id = ?", [now, streamId])
  }
}

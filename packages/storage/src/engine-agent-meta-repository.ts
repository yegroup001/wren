import type { Database } from "bun:sqlite"
import type { EngineAgentMeta } from "./engine-transcript-types"

type AgentMetaRow = {
  readonly agent_id: string
  readonly session_id: string
  readonly agent_type: string | null
  readonly worktree_path: string | null
  readonly description: string | null
}

/**
 * Subagent metadata — the SQLite replacement for the agent-<id>.meta.json
 * sidecar files. Keyed by the globally unique agentId; session_id scopes
 * the row for cascade cleanup and ownership.
 */
export class EngineAgentMetaRepository {
  constructor(private readonly db: Database) {}

  save(sessionId: string, meta: EngineAgentMeta, now: string): void {
    // Agent metadata can arrive before the first transcript event (runAgent
    // writes metadata when the fork starts); ensure the owning session row
    // exists so the FK holds. ensureSession in the event path overwrites the
    // empty project_path placeholder with the real value.
    this.db.run(
      `INSERT OR IGNORE INTO engine_session (id, project_path, created_at, updated_at)
       VALUES (?, '', ?, ?)`,
      [sessionId, now, now],
    )
    this.db.run(
      `INSERT INTO engine_agent_meta
       (agent_id, session_id, agent_type, worktree_path, description, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         session_id = excluded.session_id,
         agent_type = excluded.agent_type,
         worktree_path = excluded.worktree_path,
         description = excluded.description,
         updated_at = excluded.updated_at`,
      [
        meta.agentId,
        sessionId,
        meta.agentType,
        meta.worktreePath ?? null,
        meta.description ?? null,
        now,
      ],
    )
  }

  get(agentId: string): EngineAgentMeta | undefined {
    const row = this.db
      .query<AgentMetaRow, [string]>(
        "SELECT agent_id, session_id, agent_type, worktree_path, description FROM engine_agent_meta WHERE agent_id = ?",
      )
      .get(agentId)
    if (row === null || row === undefined || row.agent_type === null) return undefined
    return {
      agentId: row.agent_id,
      sessionId: row.session_id,
      agentType: row.agent_type,
      ...(row.worktree_path !== null && { worktreePath: row.worktree_path }),
      ...(row.description !== null && { description: row.description }),
    }
  }
}

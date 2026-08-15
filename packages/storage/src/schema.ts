
export const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = FULL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA cache_size = -64000",
] as const

export const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS session (
    id               TEXT PRIMARY KEY,
    cwd              TEXT NOT NULL,
    model_id         TEXT NOT NULL,
    model_ref        TEXT,
    permission_mode  TEXT NOT NULL,
    effort           TEXT,
    title            TEXT,
    status           TEXT NOT NULL,
    diff             TEXT NOT NULL DEFAULT '[]',
    time_created     TEXT NOT NULL,
    time_updated     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    role           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    error          TEXT,
    compact_summary TEXT,
    time_created   TEXT NOT NULL,
    time_updated   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS part (
    id           TEXT PRIMARY KEY,
    message_id   TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,
    data         TEXT NOT NULL,
    time_created TEXT NOT NULL,
    time_updated TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS todo (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,
    content      TEXT NOT NULL,
    time_created TEXT NOT NULL,
    time_updated TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS permission (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    tool_name     TEXT NOT NULL,
    display_type  TEXT NOT NULL,
    input         TEXT NOT NULL,
    time_created  TEXT NOT NULL,
    time_updated  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS engine_session (
    id           TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS engine_stream (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES engine_session(id) ON DELETE CASCADE,
    agent_id     TEXT,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    team_name    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE(session_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS engine_event (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES engine_session(id) ON DELETE CASCADE,
    stream_id       TEXT NOT NULL REFERENCES engine_stream(id) ON DELETE CASCADE,
    sequence        INTEGER NOT NULL,
    type            TEXT NOT NULL,
    timestamp       TEXT,
    message_uuid    TEXT,
    parent_uuid     TEXT,
    is_compact      INTEGER NOT NULL DEFAULT 0,
    payload         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(stream_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS engine_agent_meta (
    agent_id      TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES engine_session(id) ON DELETE CASCADE,
    agent_type    TEXT,
    worktree_path TEXT,
    description   TEXT,
    updated_at    TEXT NOT NULL
  )`,
] as const

export const INDEX_DDL = [
  "CREATE INDEX IF NOT EXISTS idx_session_time_updated ON session(time_updated DESC)",
  "CREATE INDEX IF NOT EXISTS idx_message_session_created ON message(session_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id)",
  "CREATE INDEX IF NOT EXISTS idx_part_session ON part(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_part_session_message ON part(session_id, message_id)",
  "CREATE INDEX IF NOT EXISTS idx_todo_session ON todo(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_permission_session ON permission(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_engine_session_project_updated ON engine_session(project_path, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_engine_event_session_id ON engine_event(session_id, id)",
  "CREATE INDEX IF NOT EXISTS idx_engine_event_message ON engine_event(session_id, message_uuid)",
  "CREATE INDEX IF NOT EXISTS idx_engine_event_parent ON engine_event(session_id, parent_uuid)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_stream_main_unique ON engine_stream(session_id) WHERE agent_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_event_message_unique ON engine_event(session_id, message_uuid) WHERE message_uuid IS NOT NULL",
] as const

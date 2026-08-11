import { describe, expect, test } from "bun:test"
import { initDatabase } from "./db"

describe("schema initialization", () => {
  test("creates all expected tables", () => {
    const db = initDatabase(":memory:")

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]

    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain("session")
    expect(tableNames).toContain("message")
    expect(tableNames).toContain("part")
    expect(tableNames).toContain("todo")
    expect(tableNames).toContain("permission")
    expect(tableNames).toContain("engine_session")
    expect(tableNames).toContain("engine_stream")
    expect(tableNames).toContain("engine_event")
    expect(tableNames).toContain("engine_agent_meta")

    // Dead tables removed in v11

    db.close()
  })

  test("creates all expected indexes", () => {
    const db = initDatabase(":memory:")

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as { name: string }[]

    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain("idx_session_time_updated")
    expect(indexNames).toContain("idx_message_session_created")
    expect(indexNames).toContain("idx_part_message")
    expect(indexNames).toContain("idx_part_session")
    expect(indexNames).toContain("idx_todo_session")
    expect(indexNames).toContain("idx_permission_session")
    // Partial unique indexes added in v12
    expect(indexNames).toContain("idx_engine_stream_main_unique")
    expect(indexNames).toContain("idx_engine_event_message_unique")
    // Redundant indexes removed in v12
    expect(indexNames).not.toContain("idx_engine_event_stream_sequence")
    expect(indexNames).not.toContain("idx_engine_stream_session")

    db.close()
  })

  test("partial unique indexes are unique and partial", () => {
    const db = initDatabase(":memory:")

    const streamIndexes = db
      .query("PRAGMA index_list(engine_stream)")
      .all() as { name: string; unique: number; partial: number }[]
    const mainUnique = streamIndexes.find((i) => i.name === "idx_engine_stream_main_unique")
    expect(mainUnique).toBeDefined()
    expect(mainUnique?.unique).toBe(1)
    expect(mainUnique?.partial).toBe(1)

    const eventIndexes = db
      .query("PRAGMA index_list(engine_event)")
      .all() as { name: string; unique: number; partial: number }[]
    const msgUnique = eventIndexes.find((i) => i.name === "idx_engine_event_message_unique")
    expect(msgUnique).toBeDefined()
    expect(msgUnique?.unique).toBe(1)
    expect(msgUnique?.partial).toBe(1)

    db.close()
  })

  test("is idempotent — second init does not duplicate tables", () => {
    const db = initDatabase(":memory:")

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]

    const names = tables.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)

    db.close()
  })

  test("session table has expected columns", () => {
    const db = initDatabase(":memory:")

    const cols = db.query("PRAGMA table_info(session)").all() as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]

    const colMap = new Map(cols.map((c) => [c.name, c]))
    expect(colMap.get("id")?.type).toBe("TEXT")
    expect(colMap.get("id")?.pk).toBe(1)
    expect(colMap.get("cwd")?.type).toBe("TEXT")
    expect(colMap.get("model_id")?.type).toBe("TEXT")
    expect(colMap.get("permission_mode")?.type).toBe("TEXT")
    expect(colMap.get("title")?.type).toBe("TEXT")
    expect(colMap.get("status")?.type).toBe("TEXT")
    expect(colMap.get("diff")?.type).toBe("TEXT")
    expect(colMap.get("engine_snapshot")).toBeUndefined()
    expect(colMap.get("time_created")?.type).toBe("TEXT")
    expect(colMap.get("time_updated")?.type).toBe("TEXT")

    db.close()
  })

  test("message table has foreign key to session with cascade delete", () => {
    const db = initDatabase(":memory:")

    const fks = db.query("PRAGMA foreign_key_list(message)").all() as {
      table: string
      on_delete: string
    }[]

    const sessionFk = fks.find((fk) => fk.table === "session")
    expect(sessionFk).toBeDefined()
    expect(sessionFk?.on_delete).toBe("CASCADE")

    db.close()
  })

  test("part table has foreign keys to message and session with cascade delete", () => {
    const db = initDatabase(":memory:")

    const fks = db.query("PRAGMA foreign_key_list(part)").all() as {
      table: string
      on_delete: string
    }[]

    expect(fks.some((fk) => fk.table === "message" && fk.on_delete === "CASCADE")).toBe(true)
    expect(fks.some((fk) => fk.table === "session" && fk.on_delete === "CASCADE")).toBe(true)

    db.close()
  })

  test("cascade delete removes child rows", () => {
    const db = initDatabase(":memory:")

    db.run(
      "INSERT INTO session (id, cwd, model_id, permission_mode, status, diff, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "ses_cascade",
        "/tmp",
        "m",
        "default",
        "{}",
        "[]",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      ],
    )
    db.run(
      "INSERT INTO message (id, session_id, role, created_at, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "msg_cascade",
        "ses_cascade",
        "user",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      ],
    )
    db.run(
      "INSERT INTO part (id, message_id, session_id, type, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "part_cascade",
        "msg_cascade",
        "ses_cascade",
        "text",
        "{}",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      ],
    )

    expect((db.query("SELECT COUNT(*) as n FROM message").get() as { n: number }).n).toBe(1)
    expect((db.query("SELECT COUNT(*) as n FROM part").get() as { n: number }).n).toBe(1)

    db.run("DELETE FROM session WHERE id = ?", ["ses_cascade"])

    expect((db.query("SELECT COUNT(*) as n FROM message").get() as { n: number }).n).toBe(0)
    expect((db.query("SELECT COUNT(*) as n FROM part").get() as { n: number }).n).toBe(0)

    db.close()
  })
})

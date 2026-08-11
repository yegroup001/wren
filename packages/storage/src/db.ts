import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { INDEX_DDL, PRAGMAS, SCHEMA_DDL } from "./schema"

export function initDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:") {
    const parent = dirname(dbPath)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    chmodSync(parent, 0o700)
  }

  const db = new Database(dbPath, { create: true })

  for (const pragma of PRAGMAS) {
    db.run(pragma)
  }

  for (const ddl of SCHEMA_DDL) {
    db.run(ddl)
  }
  for (const ddl of INDEX_DDL) {
    db.run(ddl)
  }

  if (dbPath !== ":memory:") {
    chmodSync(dbPath, 0o600)
  }

  return db
}

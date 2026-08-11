import { createEngineTranscriptStore, type EngineTranscriptStore } from "@wren/storage"

/**
 * The app-level transcript mirror: a handle to the engine_* tables in
 * sessions.db that mirror the vendored engine's JSONL transcript writes.
 *
 * The mirror module deliberately imports nothing from the vendored engine —
 * sessionStorage.ts imports getTranscriptStore() here, so any import in the
 * other direction would create a cycle. The entry → event mapping
 * (mirrorEntryToSqlite) lives in sessionStorage.ts next to the helpers it
 * needs; the app wires it up with setEntryMirror().
 */
let store: EngineTranscriptStore | null = null

/** Open the mirror store on the same sessions.db used by the adapter. */
export function initTranscriptMirror(dbPath: string): void {
  if (store !== null) return
  store = createEngineTranscriptStore(dbPath)
}

export function getTranscriptStore(): EngineTranscriptStore | null {
  return store
}

export function closeTranscriptMirror(): void {
  store?.close()
  store = null
}

export function deleteTranscriptMirror(sessionId: string): void {
  store?.deleteSession(sessionId)
}

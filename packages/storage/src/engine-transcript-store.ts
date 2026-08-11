import { initDatabase } from "./db"
import { EngineAgentMetaRepository } from "./engine-agent-meta-repository"
import { EngineEventRepository } from "./engine-event-repository"
import { EngineSessionRepository } from "./engine-session-repository"
import type { EngineTranscriptStore } from "./engine-transcript-types"

export type {
  EngineAgentMeta,
  EngineEvent,
  EngineEventInput,
  EngineStreamRef,
  EngineTranscriptStore,
} from "./engine-transcript-types"

export function createEngineTranscriptStore(dbPath: string): EngineTranscriptStore {
  const db = initDatabase(dbPath)
  const sessions = new EngineSessionRepository(db)
  const events = new EngineEventRepository(db, sessions)
  const agentMeta = new EngineAgentMetaRepository(db)

  const store: EngineTranscriptStore = {
    append: async (sessionId, projectPath, stream, newEvents) =>
      events.append(sessionId, projectPath, stream, newEvents),
    events: async (sessionId, stream) => events.events(sessionId, stream),
    hasMessage: async (sessionId, messageUuid) => events.hasMessage(sessionId, messageUuid),
    messageUuids: async (sessionId) => events.messageUuids(sessionId),
    saveAgentMeta: async (sessionId, meta) => {
      agentMeta.save(sessionId, meta, new Date().toISOString())
    },
    agentMeta: async (agentId) => agentMeta.get(agentId),
    sessionsTouchedSince: (projectPath, sinceIso) =>
      sessions.sessionsTouchedSince(projectPath, sinceIso),
    sessionExists: (sessionId) => sessions.sessionExists(sessionId),
    deleteSession: (sessionId) => sessions.deleteSession(sessionId),
    close: () => db.close(),
  }

  return store
}

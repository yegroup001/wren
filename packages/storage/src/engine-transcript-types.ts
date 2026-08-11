export type EngineEventInput = {
  readonly type: string
  readonly payload: unknown
  readonly timestamp?: string
  readonly messageUuid?: string
  readonly parentUuid?: string | null
  readonly isCompact?: boolean
}

export type EngineEvent = EngineEventInput & {
  readonly sequence: number
  readonly streamId: string
}

export type EngineStreamRef = {
  readonly sessionId: string
  readonly agentId?: string
  readonly isSidechain?: boolean
  readonly teamName?: string
}

export type EngineAgentMeta = {
  readonly agentId: string
  readonly sessionId: string
  readonly agentType: string
  readonly worktreePath?: string
  readonly description?: string
}

export interface EngineTranscriptStore {
  append(
    sessionId: string,
    projectPath: string,
    stream: EngineStreamRef,
    events: readonly EngineEventInput[],
  ): Promise<readonly EngineEvent[]>
  events(sessionId: string, stream?: EngineStreamRef): Promise<readonly EngineEvent[]>
  hasMessage(sessionId: string, messageUuid: string): Promise<boolean>
  messageUuids(sessionId: string): Promise<readonly string[]>
  saveAgentMeta(sessionId: string, meta: EngineAgentMeta): Promise<void>
  agentMeta(agentId: string): Promise<EngineAgentMeta | undefined>
  sessionsTouchedSince(projectPath: string, sinceIso: string): readonly string[]
  sessionExists(sessionId: string): boolean
  deleteSession(sessionId: string): void
  close(): void
}

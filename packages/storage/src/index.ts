import type { Result, SessionBundle, SessionPreview } from "@wren/protocol"
import { err, ok } from "@wren/protocol"

export type StorageLoadError =
  | { readonly kind: "not_found"; readonly sessionId: string }
  | { readonly kind: "corrupted"; readonly sessionId: string; readonly reason: string }
export type SkippedSession = {
  readonly sessionId: string
  readonly reason: string
  readonly path: string
}

export type SessionSummary = Omit<SessionBundle, "messages"> & {
  readonly preview?: SessionPreview
}

export type SessionStoreList = {
  readonly bundles: readonly SessionBundle[]
  readonly skipped: readonly SkippedSession[]
}

export type SessionStoreSummaryList = {
  readonly bundles: readonly SessionSummary[]
  readonly skipped: readonly SkippedSession[]
}

export interface SessionStore {
  save(bundle: SessionBundle): Promise<void>
  load(sessionId: string): Promise<Result<SessionBundle, StorageLoadError>>
  list(cwd?: string): Promise<SessionStoreList>
  listSummaries(cwd?: string): Promise<SessionStoreSummaryList>
  delete(sessionId: string): Promise<void>
  saveSessionMeta(meta: SessionMetaUpdate): Promise<void>
  messageCount(sessionId: string): Promise<number>
  close(): void
}

export type SessionMetaUpdate = {
  readonly session: SessionBundle["session"]
  readonly status: SessionBundle["status"]
  readonly diff: SessionBundle["diff"]
}

export function createMemorySessionStore(): SessionStore {
  return new MemorySessionStore()
}

export {
  createEngineTranscriptStore,
  type EngineAgentMeta,
  type EngineEvent,
  type EngineEventInput,
  type EngineStreamRef,
  type EngineTranscriptStore,
} from "./engine-transcript-store"
export { createSqliteSessionStore } from "./sqlite-store"

class MemorySessionStore implements SessionStore {
  private readonly bundles = new Map<string, SessionBundle>()
  private saveOrder = 0
  private readonly saveOrders = new Map<string, number>()

  async save(bundle: SessionBundle): Promise<void> {
    this.bundles.set(bundle.session.id, bundle)
    this.saveOrders.set(bundle.session.id, this.saveOrder++)
  }

  async load(sessionId: string): Promise<Result<SessionBundle, StorageLoadError>> {
    const bundle = this.bundles.get(sessionId)
    if (!bundle) return err({ kind: "not_found", sessionId })
    return ok(bundle)
  }

  async list(cwd?: string): Promise<SessionStoreList> {
    let bundles = Array.from(this.bundles.values())
    if (cwd !== undefined) {
      bundles = bundles.filter((b) => b.session.cwd === cwd)
    }
    bundles.sort((a, b) => {
      const cmp = compareByRecency(a, b)
      if (cmp !== 0) return cmp
      const aOrder = this.saveOrders.get(a.session.id) ?? 0
      const bOrder = this.saveOrders.get(b.session.id) ?? 0
      return bOrder - aOrder
    })
    return { bundles, skipped: [] }
  }

  async listSummaries(cwd?: string): Promise<SessionStoreSummaryList> {
    const list = await this.list(cwd)
    return {
      bundles: list.bundles.map(toSessionSummary),
      skipped: list.skipped,
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.bundles.delete(sessionId)
    this.saveOrders.delete(sessionId)
  }

  async saveSessionMeta(meta: SessionMetaUpdate): Promise<void> {
    const existing = this.bundles.get(meta.session.id)
    if (existing === undefined) return
    this.bundles.set(meta.session.id, {
      ...existing,
      session: meta.session,
      status: meta.status,
      diff: meta.diff,
    })
  }

  close(): void {
    // No resources to release for the in-memory store.
  }

  async messageCount(sessionId: string): Promise<number> {
    return this.bundles.get(sessionId)?.messages.length ?? 0
  }
}

function toSessionSummary(bundle: SessionBundle): SessionSummary {
  const previewMessage = bundle.messages.find(
    (message) => message.role === "user" && message.parts.some((part) => part.type === "text"),
  )
  const previewPart = previewMessage?.parts.find((part) => part.type === "text")
  const { messages: _messages, ...summary } = bundle
  return {
    ...summary,
    ...(previewMessage !== undefined &&
      previewPart !== undefined && {
        preview: { createdAt: previewMessage.createdAt, text: previewPart.text },
      }),
  }
}

function compareByRecency(a: SessionBundle, b: SessionBundle): number {
  const aLast = a.messages.length > 0 ? a.messages[a.messages.length - 1]?.createdAt : undefined
  const bLast = b.messages.length > 0 ? b.messages[b.messages.length - 1]?.createdAt : undefined
  if (aLast !== undefined && bLast !== undefined) {
    return bLast.localeCompare(aLast)
  }
  if (aLast !== undefined) return -1
  if (bLast !== undefined) return 1
  return 0
}

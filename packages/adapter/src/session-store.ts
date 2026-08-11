import type { SessionBundle } from "@wren/protocol"

export type SessionStore = {
  readonly save: (bundle: SessionBundle) => Promise<void>
  readonly load: (sessionId: string) => Promise<unknown>
  readonly list: () => Promise<{
    readonly bundles: readonly SessionBundle[]
    readonly skipped: readonly unknown[]
  }>
  readonly delete: (sessionId: string) => Promise<void>
}

export function createMemorySessionStore(): SessionStore {
  return new MemorySessionStore()
}

class MemorySessionStore implements SessionStore {
  private readonly bundles = new Map<string, SessionBundle>()

  async save(bundle: SessionBundle): Promise<void> {
    this.bundles.set(bundle.session.id, bundle)
  }

  async load(sessionId: string): Promise<SessionBundle | undefined> {
    return this.bundles.get(sessionId)
  }

  async list(): Promise<{
    readonly bundles: readonly SessionBundle[]
    readonly skipped: readonly unknown[]
  }> {
    return { bundles: Array.from(this.bundles.values()), skipped: [] }
  }

  async delete(sessionId: string): Promise<void> {
    this.bundles.delete(sessionId)
  }
}

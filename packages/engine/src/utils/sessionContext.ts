import { AsyncLocalStorage } from "async_hooks"

export type SessionStorageContext = {
  readonly sessionId: string
  readonly projectPath: string
}

const sessionContextStorage = new AsyncLocalStorage<SessionStorageContext>()

export function getSessionStorageContext(): SessionStorageContext | undefined {
  return sessionContextStorage.getStore()
}

export function runWithSessionStorageContext<T>(context: SessionStorageContext, fn: () => T): T {
  return sessionContextStorage.run(context, fn)
}

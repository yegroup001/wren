import type { WrenApplication } from "@wren/application"
import type { Diff, Message, Session, SessionId, SessionPreview, Status, Todo } from "@wren/protocol"
import type { TuiStoreApi } from "./store"

/**
 * Create a proxy TuiStoreApi that wraps an existing store and mirrors every
 * mutation into ApplicationState. This lets the message-mapper (which takes
 * a TuiStoreApi) update both stores without any code changes.
 *
 * The proxy delegates to the underlying Solid store for reactivity, then
 * performs the same mutation on the plain ApplicationState maps.
 */
export function createDualPathStore(underlying: TuiStoreApi, app: WrenApplication): TuiStoreApi {
  const ensureSession = (sessionId: SessionId): void => {
    if (!app.state.messages.has(sessionId)) {
      app.state.messages.set(sessionId, [])
      app.state.permissions.set(sessionId, [])
      app.state.questions.set(sessionId, [])
      app.state.todos.set(sessionId, [])
      app.state.diffs.set(sessionId, { sessionId, files: [], updatedAt: "" })
      app.state.status.set(sessionId, { type: "idle" })
    }
  }

  const cloneMessage = (message: Message): Message => ({
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
  })

  return {
    store: underlying.store,
    addSession: (session) => {
      underlying.addSession(session)
      app.state.sessions.set(session.id, session)
      ensureSession(session.id)
    },
    setPreview: (sessionId, preview) => {
      underlying.setPreview(sessionId, preview)
      app.state.previews.set(sessionId, preview)
    },
    getSession: underlying.getSession,
    setSessionModel: (sessionId, modelId, modelRef) => {
      underlying.setSessionModel(sessionId, modelId, modelRef)
      const s = app.state.sessions.get(sessionId)
      if (s)
        app.state.sessions.set(sessionId, {
          ...s,
          modelId,
          ...(modelRef !== undefined && { modelRef }),
        })
    },
    setSessionPermissionMode: (sessionId, permissionMode) => {
      underlying.setSessionPermissionMode(sessionId, permissionMode)
      const s = app.state.sessions.get(sessionId)
      if (s) app.state.sessions.set(sessionId, { ...s, permissionMode })
    },
    setSessionEffort: (sessionId, effort) => {
      underlying.setSessionEffort(sessionId, effort)
      const s = app.state.sessions.get(sessionId)
      if (s) {
        app.state.sessions.set(sessionId, {
          ...s,
          effort,
          ...(s.modelRef !== undefined && {
            modelRef: modelReferenceWithEffort(s.modelRef, effort),
          }),
        })
      }
    },
    deleteSession: (sessionId) => {
      underlying.deleteSession(sessionId)
      app.state.sessions.delete(sessionId)
      app.state.previews.delete(sessionId)
      app.state.messages.delete(sessionId)
      app.state.permissions.delete(sessionId)
      app.state.questions.delete(sessionId)
      app.state.todos.delete(sessionId)
      app.state.diffs.delete(sessionId)
      app.state.status.delete(sessionId)
    },
    hydrateSessionMessages: (sessionId, messages) => {
      underlying.hydrateSessionMessages(sessionId, messages)
      // Shallow copy is sufficient — messages come from JSON.parse (plain
      // objects, not SolidJS proxies). The underlying store does its own
      // deep clone; this mirror just needs independent array references.
      app.state.messages.set(
        sessionId,
        messages.map(cloneMessage),
      )
    },
    addMessage: (message) => {
      underlying.addMessage(message)
      ensureSession(message.sessionId)
      const msgs = app.state.messages.get(message.sessionId)
      if (msgs) {
        const filtered = msgs.filter((m) => m.id !== message.id)
        filtered.push(cloneMessage(message))
        app.state.messages.set(message.sessionId, filtered)
      }
    },
    addMessageBeforeQueued: (message) => {
      underlying.addMessageBeforeQueued(message)
      ensureSession(message.sessionId)
      const msgs = app.state.messages.get(message.sessionId)
      if (msgs) {
        const filtered = msgs.filter((m) => m.id !== message.id)
        const firstQueuedIdx = filtered.findIndex((m) => m.queued === true)
        if (firstQueuedIdx === -1) {
          filtered.push(cloneMessage(message))
        } else {
          filtered.splice(firstQueuedIdx, 0, cloneMessage(message))
        }
        app.state.messages.set(message.sessionId, filtered)
      }
    },
    removeMessage: (sessionId, messageId) => {
      underlying.removeMessage(sessionId, messageId)
      const msgs = app.state.messages.get(sessionId)
      if (msgs) {
        app.state.messages.set(
          sessionId,
          msgs.filter((m) => m.id !== messageId),
        )
      }
    },
    removeMessagesFrom: (sessionId, messageId) => {
      underlying.removeMessagesFrom(sessionId, messageId)
      const msgs = app.state.messages.get(sessionId)
      if (msgs) {
        const idx = msgs.findIndex((m) => m.id === messageId)
        if (idx !== -1) {
          app.state.messages.set(sessionId, msgs.slice(0, idx))
        }
      }
    },
    replaceMessage: (sessionId, oldMessageId, newMessage) => {
      underlying.replaceMessage(sessionId, oldMessageId, newMessage)
      const msgs = app.state.messages.get(sessionId)
      if (msgs) {
        const mirroredMessage = cloneMessage(newMessage)
        const idx = msgs.findIndex((m) => m.id === oldMessageId)
        if (idx !== -1) {
          const next = [...msgs]
          next[idx] = mirroredMessage
          app.state.messages.set(sessionId, next)
        } else {
          app.state.messages.set(sessionId, [...msgs, mirroredMessage])
        }
      }
    },
    addPart: (sessionId, messageId, part) => {
      underlying.addPart(sessionId, messageId, part)
      const msgs = app.state.messages.get(sessionId)
      if (!msgs) return
      // In-place push to avoid O(n) array map per content block start
      const mirroredPart = structuredClone(part)
      const last = msgs[msgs.length - 1]
      if (last && last.id === messageId) {
        last.parts.push(mirroredPart)
        return
      }
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]!
        if (msg.id === messageId) {
          msg.parts.push(mirroredPart)
          return
        }
      }
    },
    updatePart: (sessionId, messageId, partId, update) => {
      underlying.updatePart(sessionId, messageId, partId, update)
      const msgs = app.state.messages.get(sessionId)
      if (!msgs) return
      // In-place update to avoid O(n) array map per part status change
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]!
        if (msg.id !== messageId) continue
        for (let j = 0; j < msg.parts.length; j++) {
          const part = msg.parts[j]!
          if (part.id === partId) {
            msg.parts[j] = update(part)
            return
          }
        }
        return
      }
    },
    appendPartText: (sessionId, messageId, partId, text) => {
      underlying.appendPartText(sessionId, messageId, partId, text)
      // In-place mutation on the app-state mirror — avoids O(n) array
      // allocation per streaming token. The SolidJS store (underlying)
      // already handles reactivity; this mirror only needs to stay
      // approximately correct for on-demand snapshot reads.
      const msgs = app.state.messages.get(sessionId)
      if (!msgs) return
      // Fast path: streaming always appends to the last message
      const last = msgs[msgs.length - 1]
      if (last && last.id === messageId) {
        for (const part of last.parts) {
          if (part.id === partId && (part.type === "text" || part.type === "thinking")) {
            part.text += text
            return
          }
        }
      }
      // Slow path: search from end (rare — e.g. concurrent multi-message)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]!
        if (msg.id !== messageId) continue
        for (const part of msg.parts) {
          if (part.id === partId && (part.type === "text" || part.type === "thinking")) {
            part.text += text
            return
          }
        }
        return
      }
    },
    setPermission: (request) => {
      underlying.setPermission(request)
      ensureSession(request.sessionId)
      const perms = app.state.permissions.get(request.sessionId)
      if (perms) {
        const filtered = perms.filter((p) => p.id !== request.id)
        filtered.push(request)
        app.state.permissions.set(request.sessionId, filtered)
      }
    },
    resolvePermission: (sessionId, requestId) => {
      underlying.resolvePermission(sessionId, requestId)
      const perms = app.state.permissions.get(sessionId)
      if (perms) {
        app.state.permissions.set(
          sessionId,
          perms.filter((p) => p.id !== requestId),
        )
      }
    },
    setQuestion: (request) => {
      underlying.setQuestion(request)
      ensureSession(request.sessionId)
      const qs = app.state.questions.get(request.sessionId)
      if (qs) {
        const filtered = qs.filter((q) => q.id !== request.id)
        filtered.push(request)
        app.state.questions.set(request.sessionId, filtered)
      }
    },
    resolveQuestion: (sessionId, requestId) => {
      underlying.resolveQuestion(sessionId, requestId)
      const qs = app.state.questions.get(sessionId)
      if (qs) {
        app.state.questions.set(
          sessionId,
          qs.filter((q) => q.id !== requestId),
        )
      }
    },
    setTodos: (sessionId, todos) => {
      underlying.setTodos(sessionId, todos)
      app.state.todos.set(sessionId, [...todos])
    },
    setStatus: (sessionId, status) => {
      underlying.setStatus(sessionId, status)
      app.state.status.set(sessionId, status)
    },
    setDiff: (diff) => {
      underlying.setDiff(diff)
      app.state.diffs.set(diff.sessionId, diff)
    },
    setCompactProgress: (sessionId, progress) => {
      underlying.setCompactProgress(sessionId, progress)
    },
    appendCompactProgress: (sessionId, type, text) => {
      underlying.appendCompactProgress(sessionId, type, text)
    },
    clearCompactProgress: (sessionId) => {
      underlying.clearCompactProgress(sessionId)
    },
    clearMessageQueued: (sessionId, messageId) => {
      underlying.clearMessageQueued(sessionId, messageId)
      const msgs = app.state.messages.get(sessionId)
      if (msgs) {
        app.state.messages.set(
          sessionId,
          msgs.map((m) => (m.id === messageId ? { ...m, queued: undefined } : m)),
        )
      }
    },
    restoreConversation: (sessionId, snapshot) => {
      underlying.restoreConversation(sessionId, snapshot)
      // Shallow copies — the snapshot is already a separate object graph
      // (captured via structuredClone in captureEditSnapshot). We just
      // need independent array references for the app-state mirror.
      app.state.messages.set(
        sessionId,
        snapshot.messages.map((m) => ({ ...m, parts: [...m.parts] })),
      )
      app.state.todos.set(sessionId, [...snapshot.todos])
      app.state.status.set(sessionId, { ...snapshot.status })
      app.state.diffs.set(sessionId, {
        ...snapshot.diff,
        files: [...snapshot.diff.files],
      })
      const s = app.state.sessions.get(sessionId)
      if (s) app.state.sessions.set(sessionId, { ...s, permissionMode: snapshot.permissionMode })
      app.state.permissions.set(sessionId, [...snapshot.permissions])
      app.state.questions.set(sessionId, [...snapshot.questions])
    },
    getBundle: underlying.getBundle,
  }
}

// ---------------------------------------------------------------------------
// Projection functions for adapter-level mutations
// ---------------------------------------------------------------------------

/**
 * Project a session creation into both the Solid store and ApplicationState.
 * Called by the adapter's createSession handler.
 */
export function projectSessionCreation(
  store: TuiStoreApi,
  app: WrenApplication,
  session: Session,
): void {
  // Solid store (existing path)
  store.addSession(session)
  // Application state (new path)
  app.state.sessions.set(session.id, session)
  app.state.messages.set(session.id, [])
  app.state.permissions.set(session.id, [])
  app.state.questions.set(session.id, [])
  app.state.todos.set(session.id, [])
  app.state.diffs.set(session.id, {
    sessionId: session.id,
    files: [],
    updatedAt: new Date().toISOString(),
  })
  app.state.status.set(session.id, { type: "idle" })
}

/**
 * Project a session deletion into both stores.
 */
export function projectSessionDeletion(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
): void {
  store.deleteSession(sessionId)
  app.state.sessions.delete(sessionId)
  app.state.previews.delete(sessionId)
  app.state.messages.delete(sessionId)
  app.state.permissions.delete(sessionId)
  app.state.questions.delete(sessionId)
  app.state.todos.delete(sessionId)
  app.state.diffs.delete(sessionId)
  app.state.status.delete(sessionId)
  app.state.controllers.delete(sessionId)
  app.lanes.delete(sessionId)
}

/**
 * Project a session model change into both stores.
 */
export function projectSessionModel(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  modelId: string,
  modelRef?: Session["modelRef"],
): void {
  store.setSessionModel(sessionId, modelId, modelRef)
  const session = app.state.sessions.get(sessionId)
  if (session !== undefined) {
    app.state.sessions.set(sessionId, {
      ...session,
      modelId,
      ...(modelRef !== undefined && { modelRef }),
    })
  }
}

/**
 * Project a session effort change into both stores.
 */
export function projectSessionEffort(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  effort: NonNullable<Session["effort"]>,
): void {
  store.setSessionEffort(sessionId, effort)
  const session = app.state.sessions.get(sessionId)
  if (session !== undefined) {
    app.state.sessions.set(sessionId, {
      ...session,
      effort,
      ...(session.modelRef !== undefined && {
        modelRef: modelReferenceWithEffort(session.modelRef, effort),
      }),
    })
  }
}

function modelReferenceWithEffort(
  modelRef: NonNullable<Session["modelRef"]>,
  effort: NonNullable<Session["effort"]>,
): NonNullable<Session["modelRef"]> {
  const { effort: _previousEffort, ...reference } = modelRef
  return { ...reference, ...(effort !== "default" && { effort }) }
}

/**
 * Project a session permission mode change into both stores.
 */
export function projectSessionPermissionMode(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  permissionMode: string,
): void {
  store.setSessionPermissionMode(sessionId, permissionMode)
  const session = app.state.sessions.get(sessionId)
  if (session !== undefined) {
    app.state.sessions.set(sessionId, { ...session, permissionMode })
  }
}

/**
 * Project a message addition into both stores.
 */
export function projectMessageAdd(
  store: TuiStoreApi,
  app: WrenApplication,
  message: Message,
): void {
  store.addMessage(message)
  const messages = app.state.messages.get(message.sessionId)
  if (messages !== undefined) {
    messages.push({
      ...message,
      parts: message.parts.map((part) => ({ ...part })),
    })
  }
}

export function projectMessageAddBeforeQueued(
  store: TuiStoreApi,
  app: WrenApplication,
  message: Message,
): void {
  store.addMessageBeforeQueued(message)
  const messages = app.state.messages.get(message.sessionId)
  if (messages !== undefined) {
    const mirroredMessage = {
      ...message,
      parts: message.parts.map((part) => ({ ...part })),
    }
    const filtered = messages.filter((m) => m.id !== message.id)
    const firstQueuedIdx = filtered.findIndex((m) => m.queued === true)
    if (firstQueuedIdx === -1) {
      filtered.push(mirroredMessage)
    } else {
      filtered.splice(firstQueuedIdx, 0, mirroredMessage)
    }
    app.state.messages.set(message.sessionId, filtered)
  }
}

/**
 * Project a message removal into both stores.
 */
export function projectMessageRemove(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  messageId: Message["id"],
): void {
  store.removeMessage(sessionId, messageId)
  const messages = app.state.messages.get(sessionId)
  if (messages !== undefined) {
    app.state.messages.set(
      sessionId,
      messages.filter((m) => m.id !== messageId),
    )
  }
}

/**
 * Project a status change into both stores.
 */
export function projectStatus(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  status: Status,
): void {
  store.setStatus(sessionId, status)
  app.state.status.set(sessionId, status)
}

/**
 * Project a preview into both stores.
 */
export function projectPreview(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  preview: SessionPreview,
): void {
  store.setPreview(sessionId, preview)
  app.state.previews.set(sessionId, preview)
}

/**
 * Project todos into both stores.
 */
export function projectTodos(
  store: TuiStoreApi,
  app: WrenApplication,
  sessionId: SessionId,
  todos: Todo[],
): void {
  store.setTodos(sessionId, todos)
  app.state.todos.set(sessionId, [...todos])
}

/**
 * Project a diff into both stores.
 */
export function projectDiff(store: TuiStoreApi, app: WrenApplication, diff: Diff): void {
  store.setDiff(diff)
  app.state.diffs.set(diff.sessionId, diff)
}

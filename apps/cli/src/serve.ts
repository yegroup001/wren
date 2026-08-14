import { randomBytes, timingSafeEqual } from "node:crypto"
import type { TuiStore } from "@wren/adapter"
import { createWrenRequest, type WrenAdapter } from "@wren/adapter"
import type {
  CompactProgress,
  Message,
  MessagePatch,
  WebSocketFrame,
  WebStatePatch,
  WebStateSnapshot,
} from "@wren/protocol"
import { createRunContext } from "./run-context"

export type WebAssets = {
  readonly html: string
  readonly js: string
  readonly css: string
}

export type WebCliOptions = {
  readonly model?: string
  readonly port?: number
  readonly open: boolean
}

export type WebServerOptions = {
  readonly adapter: WrenAdapter
  readonly assets: WebAssets
  readonly cwd: string
  readonly host?: string
  readonly port?: number
  readonly token?: string
  readonly pollIntervalMs?: number
}

export type WebServerHandle = {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly token: string
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Snapshot serialization / diffing (pure)
// ---------------------------------------------------------------------------

export function snapshotFromStore(
  store: TuiStore,
  titles?: Readonly<Record<string, string>>,
): WebStateSnapshot {
  // JSON roundtrip: strips Solid store proxies and undefined values so both
  // sides of every comparison are plain, stable JSON.
  return JSON.parse(
    JSON.stringify({
      sessions: store.sessions,
      titles: titles ?? {},
      previews: store.previews,
      messages: store.messages,
      permissions: store.permissions,
      questions: store.questions,
      todos: store.todos,
      status: store.status,
      diffs: store.diffs,
      compactProgress: store.compactProgress,
    }),
  ) as WebStateSnapshot
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function diffMessages(
  prev: Record<string, Message[]>,
  next: Record<string, Message[]>,
): MessagePatch[] | undefined {
  const sessionIds = new Set([...Object.keys(prev), ...Object.keys(next)])
  const patches: MessagePatch[] = []
  for (const sessionId of sessionIds) {
    const before = prev[sessionId] ?? []
    const after = next[sessionId] ?? []
    if (before.length !== after.length) {
      patches.push({ sessionId, mode: "replaceAll", messages: after })
      continue
    }
    if (before.length === 0) continue
    const sameOrder = before.every((message, i) => message.id === after[i]?.id)
    if (!sameOrder) {
      patches.push({ sessionId, mode: "replaceAll", messages: after })
      continue
    }
    const changed: Message[] = []
    for (let i = 0; i < before.length; i++) {
      const afterMessage = after[i]
      if (afterMessage !== undefined && !jsonEqual(before[i], afterMessage)) {
        changed.push(afterMessage)
      }
    }
    if (changed.length > 0) patches.push({ sessionId, mode: "upsert", messages: changed })
  }
  return patches.length > 0 ? patches : undefined
}

export function diffSnapshots(
  previous: WebStateSnapshot,
  next: WebStateSnapshot,
): WebStatePatch | null {
  const patch: WebStatePatch = {}
  if (!jsonEqual(previous.sessions, next.sessions)) patch.sessions = next.sessions
  if (!jsonEqual(previous.titles, next.titles)) patch.titles = next.titles
  if (!jsonEqual(previous.previews, next.previews)) patch.previews = next.previews
  if (!jsonEqual(previous.todos, next.todos)) patch.todos = next.todos
  if (!jsonEqual(previous.status, next.status)) patch.status = next.status
  if (!jsonEqual(previous.diffs, next.diffs)) patch.diffs = next.diffs
  if (!jsonEqual(previous.compactProgress, next.compactProgress)) {
    patch.compactProgress = next.compactProgress as Record<string, CompactProgress | undefined>
  }
  if (!jsonEqual(previous.permissions, next.permissions)) patch.permissions = next.permissions
  if (!jsonEqual(previous.questions, next.questions)) patch.questions = next.questions
  const messages = diffMessages(previous.messages, next.messages)
  if (messages !== undefined) patch.messages = messages
  return Object.keys(patch).length > 0 ? patch : null
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// Minimal structural view of a WebSocket used for broadcasting; matches both
// Bun's ServerWebSocket and the DOM WebSocket API.
type WsSocket = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const { adapter, assets, cwd } = options
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const token = options.token ?? randomBytes(24).toString("base64url")
  const pollIntervalMs = options.pollIntervalMs ?? 80

  const sockets = new Set<WsSocket>()

  const snapshotNow = (): WebStateSnapshot =>
    snapshotFromStore(adapter.state.store, adapter.titles?.())
  // Baseline captured at startup so changes that land before the first poll
  // tick still produce a patch (the first tick would otherwise swallow them).
  let previous: WebStateSnapshot = snapshotNow()

  function authorize(url: URL, request: Request): boolean {
    const provided = url.searchParams.get("token") ?? request.headers.get("x-wren-token")
    if (provided === null) return false
    const a = new TextEncoder().encode(provided)
    const b = new TextEncoder().encode(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const unauthorized = (): Response => new Response("unauthorized", { status: 401 })

  function serveStatic(pathname: string): Response {
    const asset =
      pathname === "/" || pathname === "/index.html"
        ? assets.html
        : pathname === "/main.js"
          ? assets.js
          : pathname === "/style.css"
            ? assets.css
            : undefined
    if (asset === undefined) return new Response("not found", { status: 404 })
    const contentType = pathname.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : pathname.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/html; charset=utf-8"
    // 'self' does not cover ws:// (different scheme), so the WebSocket origin
    // is whitelisted explicitly.
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ws://${host}:${actualPort}`,
    ].join("; ")
    return new Response(asset, {
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        "content-security-policy": csp,
      },
    })
  }

  async function proxyApi(url: URL, request: Request): Promise<Response> {
    const innerPath = `${url.pathname.slice("/api".length) || "/"}${url.search}`
    const headers = new Headers()
    const contentType = request.headers.get("content-type")
    if (contentType !== null) headers.set("content-type", contentType)
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    const inner = createWrenRequest(innerPath, {
      method: request.method,
      headers,
      ...(body !== undefined && { body }),
    })
    const response = await adapter.fetch(inner)
    const text = await response.text()
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    })
  }

  function broadcast(frame: WebSocketFrame): void {
    const text = JSON.stringify(frame)
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text)
    }
  }

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname === "/ws") {
        if (!authorize(url, request)) return unauthorized()
        if (server.upgrade(request)) return undefined
        return new Response("websocket upgrade failed", { status: 400 })
      }
      if (url.pathname === "/api/state") {
        if (!authorize(url, request)) return unauthorized()
        return new Response(JSON.stringify(snapshotNow()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        })
      }
      if (url.pathname === "/api/models") {
        if (!authorize(url, request)) return unauthorized()
        const { loadModelRegistry } = await import("@wren/config-node")
        const registry = loadModelRegistry(cwd)
        return new Response(JSON.stringify({ entries: registry.entries }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        })
      }
      if (url.pathname.startsWith("/api/")) {
        if (!authorize(url, request)) return unauthorized()
        return proxyApi(url, request)
      }
      return serveStatic(url.pathname)
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        socket.send(
          JSON.stringify({ type: "snapshot", state: snapshotNow() } satisfies WebSocketFrame),
        )
      },
      message() {
        // Client → server messages are not used yet; commands go over HTTP.
      },
      close(socket) {
        sockets.delete(socket)
      },
    },
  })

  const timer = setInterval(() => {
    const next = snapshotNow()
    const patch = diffSnapshots(previous, next)
    if (patch !== null) {
      previous = next
      broadcast({ type: "patch", patch })
    }
  }, pollIntervalMs)

  const actualPort = server.port ?? port

  return {
    url: `http://${host}:${actualPort}/?token=${token}`,
    host,
    port: actualPort,
    token,
    stop: async () => {
      clearInterval(timer)
      for (const socket of sockets) socket.close(1001, "server shutting down")
      server.stop(true)
    },
  }
}

// ---------------------------------------------------------------------------
// CLI entry — `wren web`
// ---------------------------------------------------------------------------

export async function loadWebAssets(): Promise<WebAssets> {
  const { loadWebAssets: loadFromDisk } = await import("./web-assets")
  return loadFromDisk()
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
    proc.unref?.()
  } catch {
    // Opening a browser is best-effort; the URL is printed either way.
  }
}

export async function runWeb(project: string | undefined, options: WebCliOptions): Promise<void> {
  const context = await createRunContext(
    project,
    options.model !== undefined ? { model: options.model } : {},
  )
  try {
    const engineState = (await import("@wren/engine")) as unknown as {
      setIsInteractive(value: boolean): void
    }
    // Permissions and questions are answered through the web UI, so the
    // engine must treat this as an interactive session.
    engineState.setIsInteractive(true)

    const assets = await loadWebAssets()
    const server = await startWebServer({
      adapter: context.adapter,
      assets,
      cwd: context.cwd,
      ...(options.port !== undefined && { port: options.port }),
    })
    console.log(`\n  Wren web GUI: ${server.url}\n  Press Ctrl+C to stop.\n`)
    if (options.open) await openBrowser(server.url)

    await new Promise<void>((resolve) => {
      const onSignal = () => resolve()
      process.once("SIGINT", onSignal)
      process.once("SIGTERM", onSignal)
    })
    await server.stop()
  } finally {
    await context.dispose()
  }
}

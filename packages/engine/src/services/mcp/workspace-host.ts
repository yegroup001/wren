import type { Command } from "../../commands.js"
import type { Tool } from "../../Tool.js"
import {
  acquireMcpConnection,
  getMcpToolsCommandsAndResources,
  releaseMcpConnection,
} from "./client.js"
import type { MCPServerConnection, ServerResource } from "./types.js"

export type WorkspaceMcpSnapshot = Readonly<{
  generation: number
  clients: readonly MCPServerConnection[]
  tools: readonly Tool[]
  commands: readonly Command[]
  resources: readonly ServerResource[]
}>

export type WorkspaceMcpSnapshotListener = (snapshot: WorkspaceMcpSnapshot) => void

export type WorkspaceMcpHostOptions = Readonly<{
  configs?: Record<string, import("./types.js").ScopedMcpServerConfig>
}>

const EMPTY_SNAPSHOT: WorkspaceMcpSnapshot = Object.freeze({
  generation: 0,
  clients: Object.freeze([]),
  tools: Object.freeze([]),
  commands: Object.freeze([]),
  resources: Object.freeze([]),
})

export class WorkspaceMcpHost {
  private readonly configs: WorkspaceMcpHostOptions["configs"]
  private snapshot: WorkspaceMcpSnapshot = EMPTY_SNAPSHOT
  private listeners = new Set<WorkspaceMcpSnapshotListener>()
  private loadPromise: Promise<WorkspaceMcpSnapshot> | undefined
  private started = false
  private disposed = false

  constructor(options: WorkspaceMcpHostOptions = {}) {
    this.configs = options.configs
  }

  async start(): Promise<WorkspaceMcpSnapshot> {
    if (this.disposed) throw new Error("WorkspaceMcpHost has been disposed")
    if (this.started) return this.snapshot
    if (this.loadPromise !== undefined) return this.loadPromise
    this.loadPromise = this.load()
    try {
      return await this.loadPromise
    } finally {
      this.loadPromise = undefined
    }
  }

  getSnapshot(): WorkspaceMcpSnapshot {
    return this.snapshot
  }

  subscribe(listener: WorkspaceMcpSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async reload(): Promise<WorkspaceMcpSnapshot> {
    if (this.disposed) throw new Error("WorkspaceMcpHost has been disposed")
    if (this.loadPromise !== undefined) return this.loadPromise
    await this.cleanupSnapshot(this.snapshot)
    this.snapshot = Object.freeze({
      ...EMPTY_SNAPSHOT,
      generation: this.snapshot.generation,
    })
    this.started = false
    return this.start()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.loadPromise !== undefined) await this.loadPromise.catch(() => {})
    await this.cleanupSnapshot(this.snapshot)
    this.snapshot = Object.freeze({
      generation: this.snapshot.generation,
      clients: Object.freeze([]),
      tools: Object.freeze([]),
      commands: Object.freeze([]),
      resources: Object.freeze([]),
    })
    this.listeners.clear()
  }

  private async load(): Promise<WorkspaceMcpSnapshot> {
    const clients: MCPServerConnection[] = []
    const tools: Tool[] = []
    const commands: Command[] = []
    const resources: ServerResource[] = []

    try {
      await getMcpToolsCommandsAndResources((result) => {
        clients.push(result.client)
        tools.push(...result.tools)
        commands.push(...result.commands)
        if (result.resources !== undefined) resources.push(...result.resources)
      }, this.configs)
    } catch {
      // Config not yet enabled or no MCP servers configured — start empty.
    }

    const next = Object.freeze({
      generation: this.snapshot.generation + 1,
      clients: Object.freeze(clients.slice()),
      tools: Object.freeze(tools.slice()),
      commands: Object.freeze(commands.slice()),
      resources: Object.freeze(resources.slice()),
    })
    for (const client of clients) {
      if (client.type === "connected") {
        acquireMcpConnection(client.name, client.config)
      }
    }
    this.snapshot = next
    this.started = true
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch {
        // A subscriber must not break MCP startup or reload.
      }
    }
    return next
  }

  private async cleanupSnapshot(snapshot: WorkspaceMcpSnapshot): Promise<void> {
    await Promise.all(
      snapshot.clients.map(async (connection) => {
        if (connection.type !== "connected") return
        await releaseMcpConnection(connection.name, connection.config, connection).catch(() => {})
      }),
    )
  }
}

export function emptyWorkspaceMcpSnapshot(): WorkspaceMcpSnapshot {
  return EMPTY_SNAPSHOT
}

import { type EventEnvelope, type GlobalEvent, parseRequestId } from "@wren/protocol"

export type EventHandler = (event: EventEnvelope) => void

export interface LocalEventSource {
  subscribe(handler: EventHandler): Promise<() => void>
}

export class LocalEventBus implements LocalEventSource {
  private readonly handlers = new Set<EventHandler>()
  private nextId = 0

  async subscribe(handler: EventHandler): Promise<() => void> {
    this.handlers.add(handler)
    handler(this.envelope(process.cwd(), { type: "server.connected" }))
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(directory: string, payload: GlobalEvent): void {
    const event = this.envelope(directory, payload)
    for (const handler of this.handlers) handler(event)
  }

  private envelope(directory: string, payload: GlobalEvent): EventEnvelope {
    this.nextId += 1
    return { id: parseRequestId(`evt_${this.nextId}`), directory, payload }
  }
}

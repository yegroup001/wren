import { describe, expect, test } from "bun:test"
import type { WrenClient } from "./index"

// ---------------------------------------------------------------------------
// Transport conformance suite — reusable tests that any WrenClient
// implementation must pass. This covers initialization, command dispatch,
// event subscription, and lifecycle.
//
// Future transports (ElectronIpcWrenClient, HttpWrenClient) should run
// the same suite against their implementation.
// ---------------------------------------------------------------------------

export function runTransportConformanceSuite(
  name: string,
  createClient: () => Promise<WrenClient>,
): void {
  describe(`transport conformance: ${name}`, () => {
    let client: WrenClient

    test("initialize returns a valid snapshot", async () => {
      client = await createClient()
      const snapshot = await client.initialize()
      expect(snapshot.protocolVersion).toBe(1)
      expect(snapshot.applicationEpoch).toBeTruthy()
      expect(typeof snapshot.applicationEpoch).toBe("string")
      expect(snapshot.cursor).toBeGreaterThanOrEqual(0)
      expect(snapshot.workspaceId).toBeTruthy()
      expect(Array.isArray(snapshot.sessions)).toBe(true)
      await client.close()
    })

    test("resync returns a valid snapshot", async () => {
      client = await createClient()
      const snapshot = await client.resync()
      expect(snapshot.protocolVersion).toBe(1)
      expect(snapshot.applicationEpoch).toBeTruthy()
      await client.close()
    })

    test("execute session.list returns ok", async () => {
      client = await createClient()
      await client.initialize()
      const result = await client.execute({
        // biome-ignore lint/suspicious/noExplicitAny: test conformance
        requestId: "conf-list" as any,
        command: { type: "session.list" },
      })
      expect(result.ok).toBe(true)
      await client.close()
    })

    test("execute unknown command returns error", async () => {
      client = await createClient()
      await client.initialize()
      const result = await client.execute({
        // biome-ignore lint/suspicious/noExplicitAny: test conformance
        requestId: "conf-unknown" as any,
        // biome-ignore lint/suspicious/noExplicitAny: test conformance
        command: { type: "session.delete" as any, sessionId: "nonexistent" },
      })
      expect(result.ok).toBe(false)
      await client.close()
    })

    test("subscribe with valid epoch returns ok", async () => {
      client = await createClient()
      const snapshot = await client.initialize()
      const start = await client.subscribe(
        { applicationEpoch: snapshot.applicationEpoch, cursor: snapshot.cursor },
        () => {},
      )
      expect(start.ok).toBe(true)
      if (start.ok) await start.unsubscribe()
      await client.close()
    })

    test("subscribe with invalid epoch returns false", async () => {
      client = await createClient()
      await client.initialize()
      const start = await client.subscribe(
        { applicationEpoch: "invalid-epoch", cursor: 0 },
        () => {},
      )
      expect(start.ok).toBe(false)
      await client.close()
    })

    test("close does not throw", async () => {
      client = await createClient()
      await client.initialize()
      await client.close()
    })
  })
}

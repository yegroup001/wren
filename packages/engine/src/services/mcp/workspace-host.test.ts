import { describe, expect, test } from "bun:test"
import { WorkspaceMcpHost } from "./workspace-host.js"

describe("WorkspaceMcpHost", () => {
  test("publishes immutable snapshots with monotonic generations", async () => {
    const host = new WorkspaceMcpHost({ configs: {} })
    const generations: number[] = []
    const unsubscribe = host.subscribe((snapshot) => generations.push(snapshot.generation))

    const first = await host.start()
    expect(first.generation).toBe(1)
    expect(first.clients).toEqual([])
    expect(first.tools).toEqual([])
    expect(Object.isFrozen(first)).toBe(true)

    const same = await host.start()
    expect(same).toBe(first)
    expect(generations).toEqual([1])

    const second = await host.reload()
    expect(second.generation).toBe(2)
    expect(second).not.toBe(first)
    expect(generations).toEqual([1, 2])

    unsubscribe()
    await host.dispose()
    await host.dispose()
    expect(host.getSnapshot().clients).toEqual([])
    await expect(host.start()).rejects.toThrow("disposed")
  })
})

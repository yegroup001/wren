import { describe, expect, test } from "bun:test"
import { EngineHistoryOwnershipError, EngineHistorySnapshot } from "./wren/history-snapshot"

describe("EngineHistorySnapshot", () => {
  test("deep clones history when captured and every time it is restored", () => {
    // Given: nested mutable history owned by one engine.
    const owner = {}
    const source = [{ role: "user", content: { text: "original" } }]
    let restored: readonly (typeof source)[number][] = []
    const snapshot = EngineHistorySnapshot.capture(owner, source, (messages) => {
      restored = messages
    })

    // When: both the source and a first restored copy are mutated.
    const sourceMessage = source[0]
    if (sourceMessage === undefined) throw new Error("expected source message")
    sourceMessage.content.text = "source mutation"
    snapshot.restoreFor(owner)
    const restoredMessage = restored[0]
    if (restoredMessage === undefined) throw new Error("expected restored message")
    restoredMessage.content.text = "restored mutation"
    snapshot.restoreFor(owner)

    // Then: a later restoration still contains the original nested value.
    expect(restored).toEqual([{ role: "user", content: { text: "original" } }])
  })

  test("rejects restoring a snapshot into a different engine owner", () => {
    // Given: a snapshot captured by one engine owner.
    const snapshot = EngineHistorySnapshot.capture({}, [], () => {})

    // When/Then: another owner cannot restore it.
    expect(() => snapshot.restoreFor({})).toThrow(EngineHistoryOwnershipError)
  })
})

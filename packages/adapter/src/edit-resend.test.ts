import { describe, expect, test } from "bun:test"
import { parseSessionId } from "@wren/protocol"
import { createMemorySessionStore } from "@wren/storage"
import { createRoot } from "solid-js"
import type { WrenEngineFactory } from "@wren/engine"
import {
  createOriginalBranchFixture,
  firstUserMessageId,
  observableState,
  request,
  secondUserMessageId,
  TransactionalFakeEngine,
} from "./edit-resend-fixture"
import { createWrenAdapter } from "./local-adapter"

const FIXED_NOW = "2026-07-13T00:00:00.000Z"

describe("local adapter edit/resend transaction", () => {
  test("restores engine anchors before editing after a fresh adapter resumes", async () => {
    const sessionStore = createMemorySessionStore()
    const original = await createOriginalBranchFixture(sessionStore)
    const editedMessageId = firstUserMessageId(original)
    const restoredHistory = original.engine.historyView()
    const resumedEngine = new TransactionalFakeEngine(restoredHistory)
    const factory: WrenEngineFactory = {
      createEngine: async () => resumedEngine,
      getDefaultModel: () => "fake/model",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => "ses_edit",
      dispose: () => {},
    }
    const resumed = createRoot((dispose) => ({
      adapter: createWrenAdapter(new TransactionalFakeEngine(), {
        clock: { now: () => FIXED_NOW },
        engineFactory: factory,
        cwd: "/tmp/project",
        sessionStore,
        restoreEngineMessages: async () => ({
          engineSessionId: "ses_edit",
          messages: restoredHistory,
        }),
      }),
      dispose,
    }))
    await resumed.adapter.resume()

    const response = await resumed.adapter.fetch(
      request(`/session/${original.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: editedMessageId,
      }),
    )
    expect(response.status).toBe(202)
    resumedEngine.releaseReplacement()
    await resumed.adapter.waitForIdle(parseSessionId(original.sessionId))

    const messages = resumed.adapter.state
      .getBundle(parseSessionId(original.sessionId))
      ?.messages.filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(messages).toEqual(["replacement succeeds"])

    resumed.dispose()
    original.dispose()
  })

  test("rejects an unknown edit message without mutation or engine submission", async () => {
    // Given: a completed original branch.
    const fixture = await createOriginalBranchFixture()
    const before = observableState(fixture)
    const submitCount = fixture.engine.submitMessageCalls.length

    // When: an edit names an unknown message.
    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: "msg_missing",
      }),
    )

    // Then: the request is rejected without changing either projection.
    expect(response.status).toBe(404)
    expect(fixture.engine.submitMessageCalls).toHaveLength(submitCount)
    expect(observableState(fixture)).toBe(before)
    fixture.dispose()
  })

  test("rejects a non-user edit message without mutation or engine submission", async () => {
    // Given: a completed branch and one assistant message ID.
    const fixture = await createOriginalBranchFixture()
    const bundle = fixture.adapter.state.getBundle(parseSessionId(fixture.sessionId))
    const assistantId = bundle?.messages.find((message) => message.role === "assistant")?.id
    if (assistantId === undefined) throw new Error("expected assistant message")
    const before = observableState(fixture)
    const submitCount = fixture.engine.submitMessageCalls.length

    // When: an edit names the assistant message.
    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: assistantId,
      }),
    )

    // Then: the request is rejected without changing either projection.
    expect(response.status).toBe(404)
    expect(fixture.engine.submitMessageCalls).toHaveLength(submitCount)
    expect(observableState(fixture)).toBe(before)
    fixture.dispose()
  })

  test("rejects a stale engine anchor without transcript mutation or submission", async () => {
    // Given: a completed branch whose engine history is no longer aligned.
    const fixture = await createOriginalBranchFixture()
    const editedMessageId = firstUserMessageId(fixture)
    fixture.engine.truncateMessages(0)
    const before = observableState(fixture)
    const submitCount = fixture.engine.submitMessageCalls.length

    // When: the user attempts to edit through the stale anchor.
    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: editedMessageId,
      }),
    )

    // Then: the conflict is explicit and no additional mutation occurs.
    expect(response.status).toBe(409)
    expect(fixture.engine.submitMessageCalls).toHaveLength(submitCount)
    expect(observableState(fixture)).toBe(before)
    fixture.dispose()
  })

  test("rejects an empty edit ID at the payload boundary", async () => {
    // Given: a completed branch.
    const fixture = await createOriginalBranchFixture()
    const before = observableState(fixture)
    const submitCount = fixture.engine.submitMessageCalls.length

    // When: editMessageId is present but empty.
    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: "",
      }),
    )

    // Then: parsing rejects it without mutation or submission.
    expect(response.status).toBe(400)
    expect(fixture.engine.submitMessageCalls).toHaveLength(submitCount)
    expect(observableState(fixture)).toBe(before)
    fixture.dispose()
  })

  test("rejects a non-string edit ID at the payload boundary", async () => {
    // Given: a completed branch.
    const fixture = await createOriginalBranchFixture()
    const before = observableState(fixture)
    const submitCount = fixture.engine.submitMessageCalls.length

    // When: editMessageId is present with the wrong type.
    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: 42,
      }),
    )

    // Then: parsing rejects it without mutation or submission.
    expect(response.status).toBe(400)
    expect(fixture.engine.submitMessageCalls).toHaveLength(submitCount)
    expect(observableState(fixture)).toBe(before)
    fixture.dispose()
  })

  test("awaits a successful resend and persists only the replacement branch", async () => {
    // Given: an edit of the first user turn in a two-turn branch.
    const fixture = await createOriginalBranchFixture()
    const editedMessageId = firstUserMessageId(fixture)

    // When: the replacement stream is sent and the engine processes it.
    const responsePromise = fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: editedMessageId,
      }),
    )
    const response = await responsePromise
    expect(response.status).toBe(202)
    await fixture.engine.replacementStarted
    fixture.engine.releaseReplacement()
    await fixture.adapter.waitForIdle(parseSessionId(fixture.sessionId))

    // Then: success contains only the replacement branch.
    const bundle = fixture.adapter.state.getBundle(parseSessionId(fixture.sessionId))
    const userText = bundle?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(userText).toEqual(["replacement succeeds"])
    expect(bundle?.todos.map((todo) => todo.id)).toEqual(["replacement-todo"])
    expect(bundle?.diff.map((file) => file.path)).toEqual(["/replacement.ts"])
    expect(JSON.stringify((await fixture.sessionStore.list()).bundles[0]?.messages)).toBe(
      JSON.stringify(bundle?.messages),
    )
    fixture.dispose()
  })

  test("awaits a successful resend when editing the second (most recent) user message", async () => {
    // Given: an edit of the second user turn in a two-turn branch.
    const fixture = await createOriginalBranchFixture()
    const editedMessageId = secondUserMessageId(fixture)

    // When: the replacement stream is sent and the engine processes it.
    const responsePromise = fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: editedMessageId,
      }),
    )
    const response = await responsePromise
    expect(response.status).toBe(202)
    await fixture.engine.replacementStarted
    fixture.engine.releaseReplacement()
    await fixture.adapter.waitForIdle(parseSessionId(fixture.sessionId))

    // Then: success contains the first turn intact plus only the replacement.
    const bundle = fixture.adapter.state.getBundle(parseSessionId(fixture.sessionId))
    const userTexts = bundle?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(userTexts).toEqual(["original first", "replacement succeeds"])
    // Todos are replaced (setTodos overwrites); diffs are accumulated.
    expect(bundle?.todos.map((todo) => todo.id)).toEqual(["replacement-todo"])
    expect(bundle?.diff.map((file) => file.path)).toEqual(["/original.ts", "/replacement.ts"])
    fixture.dispose()
  })

  test("retains the replacement branch after partial output failure", async () => {
    const fixture = await createOriginalBranchFixture()
    const sessionId = parseSessionId(fixture.sessionId)
    const editedMessageId = firstUserMessageId(fixture)

    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement fails",
        editMessageId: editedMessageId,
      }),
    )
    expect(response.status).toBe(202)
    await fixture.adapter.waitForIdle(sessionId)

    const after = fixture.adapter.state.getBundle(sessionId)
    if (after === undefined) throw new Error("expected session bundle")

    // The new user message is retained, not rolled back to the original.
    const userTexts = after.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(userTexts).toEqual(["replacement fails"])

    // The old edited message is gone.
    expect(after.messages.some((message) => message.id === editedMessageId)).toBe(false)

    // An error message was appended as the last message.
    const errors = after.messages.filter((message) => message.error === "resend failed")
    expect(errors).toHaveLength(1)
    expect(after.messages.at(-1)?.id).toBe(errors[0]?.id)

    // Status is idle, not stuck on "working".
    expect(after.status.type).toBe("idle")

    // Engine history was NOT rolled back — it retains the replacement messages.
    const engineHistoryJson = JSON.stringify(fixture.engine.historyView())
    expect(engineHistoryJson).toContain("replacement fails")
    expect(engineHistoryJson).not.toContain("original first")

    // Persisted state matches the in-memory state.
    const persisted = (await fixture.sessionStore.list()).bundles[0]
    expect(persisted).toBeDefined()
    expect(JSON.stringify(persisted?.messages)).toBe(JSON.stringify(after.messages))
    expect(persisted?.status.type).toBe("idle")
    fixture.dispose()
  })

  test("allows re-editing the replacement message after a failed resend", async () => {
    const fixture = await createOriginalBranchFixture()
    const sessionId = parseSessionId(fixture.sessionId)
    const editedMessageId = firstUserMessageId(fixture)

    // First: a failed resend replaces the edited message with "replacement fails".
    const failure = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement fails",
        editMessageId: editedMessageId,
      }),
    )
    expect(failure.status).toBe(202)
    await fixture.adapter.waitForIdle(sessionId)

    // The old message is gone; the new replacement message is in the store.
    const bundleAfterFailure = fixture.adapter.state.getBundle(sessionId)
    const replacementMessageId = bundleAfterFailure?.messages.find(
      (message) => message.role === "user",
    )?.id
    if (replacementMessageId === undefined) throw new Error("expected replacement user message")

    // Re-edit the replacement message with "replacement succeeds".
    const retryPromise = fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement succeeds",
        editMessageId: replacementMessageId,
      }),
    )
    await fixture.engine.replacementStarted
    fixture.engine.releaseReplacement()
    const retry = await retryPromise
    await fixture.adapter.waitForIdle(sessionId)

    expect(retry.status).toBe(202)
    expect(fixture.engine.submitMessageCalls.at(-1)).toBe("replacement succeeds")

    // The final state has only the successful replacement.
    const finalBundle = fixture.adapter.state.getBundle(sessionId)
    const finalUserTexts = finalBundle?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(finalUserTexts).toEqual(["replacement succeeds"])
    fixture.dispose()
  })

  test("retains the replacement branch after an SDK error result", async () => {
    const fixture = await createOriginalBranchFixture()
    const sessionId = parseSessionId(fixture.sessionId)
    const editedMessageId = firstUserMessageId(fixture)

    const response = await fixture.adapter.fetch(
      request(`/session/${fixture.sessionId}/message`, {
        prompt: "replacement result error",
        editMessageId: editedMessageId,
      }),
    )
    expect(response.status).toBe(202)
    await fixture.adapter.waitForIdle(sessionId)

    const after = fixture.adapter.state.getBundle(sessionId)
    if (after === undefined) throw new Error("expected session bundle")

    // The new user message is retained, not rolled back to the original.
    const userTexts = after.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(userTexts).toEqual(["replacement result error"])

    // The old edited message is gone.
    expect(after.messages.some((message) => message.id === editedMessageId)).toBe(false)

    // The SDK error was surfaced as an error message.
    expect(
      after.messages.filter((message) => message.error === "terminal resend error"),
    ).toHaveLength(1)

    // Status is idle.
    expect(after.status.type).toBe("idle")
    fixture.dispose()
  })
})

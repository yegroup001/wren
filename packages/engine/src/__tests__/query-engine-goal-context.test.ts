import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
  setSessionPersistenceDisabled,
} from "../bootstrap/state.js"
import { getEmptyToolPermissionContext } from "../Tool.js"
import type { AppState } from "../state/AppState.js"
import type { AssistantMessage } from "../types/message.js"
import { FileStateCache } from "../utils/fileStateCache.js"
import { setConfigForTests } from "../utils/model/configBridge.js"

const capturedSystemPrompts: unknown[] = []
let queryOutputs: Array<unknown | ((args: { toolUseContext: { abortController: AbortController } }) => void)> = []

mock.module("../query.js", () => ({
  query: async function* (args: {
    systemPrompt: unknown
    toolUseContext: { abortController: AbortController }
  }) {
    capturedSystemPrompts.push(args.systemPrompt)
    for (const output of queryOutputs) {
      if (typeof output === "function") {
        output(args)
      } else {
        yield output
      }
    }
  },
}))

const { QueryEngine } = await import("../QueryEngine.js")

let testCwd = ""
const GOAL_CONTEXT = "<active-goal>Finish the verified objective.</active-goal>"

function createAppState(): AppState {
  return {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    fileHistory: {},
    attribution: {},
    sessionHooks: new Map(),
  } as AppState
}

function createEngine(getGoalContext: () => string | undefined): InstanceType<typeof QueryEngine> {
  let appState = createAppState()
  return new QueryEngine({
    cwd: testCwd,
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
    getAppState: () => appState,
    setAppState: (updater) => {
      appState = updater(appState)
    },
    readFileCache: new FileStateCache(10, 1024),
    customSystemPrompt: "Base system prompt",
    getGoalContext,
  })
}

beforeEach(async () => {
  capturedSystemPrompts.length = 0
  queryOutputs = []
  testCwd = await mkdtemp(join(tmpdir(), "query-engine-goal-context-"))
  resetStateForTests()
  setOriginalCwd(testCwd)
  setCwdState(testCwd)
  setProjectRoot(testCwd)
  setSessionPersistenceDisabled(true)
  setConfigForTests({
    defaultModel: { source: "test", model: "claude-sonnet-4-5-20250929" },
    smallFastModel: { source: "test", model: "claude-sonnet-4-5-20250929" },
    sources: {
      test: {
        type: "openai-compatible-chat",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key-not-real",
        models: {
          "claude-sonnet-4-5-20250929": {
            contextWindow: 128000,
            supportsThinking: false,
          },
        },
      },
    },
  })
})

afterEach(async () => {
  resetStateForTests()
  setConfigForTests(null)
  if (testCwd) await rm(testCwd, { recursive: true, force: true })
  testCwd = ""
})

function assistantResponse(): AssistantMessage {
  return {
    type: "assistant",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: {
      id: "query-engine-test-response",
      type: "message",
      role: "assistant",
      model: "test-model",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: "text", text: "done" }],
    },
  } as unknown as AssistantMessage
}

function messageStart(usage: Record<string, number> = {}) {
  return {
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          ...usage,
        },
      },
    },
  }
}

function messageDelta(usage: Record<string, number>) {
  return {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage,
    },
  }
}

function messageStop() {
  return { type: "stream_event", event: { type: "message_stop" } }
}

async function collectResultUsage(engine: InstanceType<typeof QueryEngine>) {
  let usage: Record<string, number> | undefined
  for await (const message of engine.submitMessage("account this response")) {
    if (message.type === "result") usage = message.usage as Record<string, number>
  }
  return usage
}
describe("QueryEngine active Goal context", () => {
  test("appends active Goal context to a normal provider request", async () => {
    const engine = createEngine(() => GOAL_CONTEXT)
    queryOutputs = [assistantResponse()]

    for await (const _message of engine.submitMessage("continue the work")) {
      // Exhaust the stream so the injected query implementation receives the request.
    }

    expect(capturedSystemPrompts).toEqual([["Base system prompt", GOAL_CONTEXT]])
  })

  test("does not add a Goal block when there is no active Goal", async () => {
    const engine = createEngine(() => undefined)
    queryOutputs = [assistantResponse()]

    for await (const _message of engine.submitMessage("ordinary request")) {
      // Exhaust the stream so the injected query implementation receives the request.
    }

    expect(capturedSystemPrompts).toEqual([["Base system prompt"]])
  })
})

describe("QueryEngine usage accounting", () => {
  test("does not count usage twice when an abort follows message_stop", async () => {
    const engine = createEngine(() => undefined)
    queryOutputs = [
      messageStart({ input_tokens: 12 }),
      messageDelta({ output_tokens: 4 }),
      messageStop(),
      (args) => args.toolUseContext.abortController.abort(),
      assistantResponse(),
    ]

    const usage = await collectResultUsage(engine)

    expect(usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 4,
      reasoning_tokens: 0,
    })
  })

  test("salvages output-only partial usage when interrupted before message_stop", async () => {
    const engine = createEngine(() => undefined)
    queryOutputs = [
      messageStart({ input_tokens: 8 }),
      messageDelta({ output_tokens: 3 }),
      (args) => args.toolUseContext.abortController.abort(),
      assistantResponse(),
    ]

    const usage = await collectResultUsage(engine)

    expect(usage).toMatchObject({
      input_tokens: 8,
      output_tokens: 3,
      reasoning_tokens: 0,
    })
  })

  test("salvages reasoning-only partial usage when interrupted before message_stop", async () => {
    const engine = createEngine(() => undefined)
    queryOutputs = [
      messageStart(),
      messageDelta({ reasoning_tokens: 9 }),
      (args) => args.toolUseContext.abortController.abort(),
      assistantResponse(),
    ]

    const usage = await collectResultUsage(engine)

    expect(usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 9,
    })
  })
})

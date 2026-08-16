import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetStateForTests, setCwdState, setOriginalCwd, setProjectRoot } from "../bootstrap/state"
import { query } from "../query"
import { getEmptyToolPermissionContext } from "../Tool"
import type { AssistantMessage } from "../types/message"
import { createUserMessage } from "../utils/messages"
import { setConfigForTests } from "../utils/model/configBridge"
import { asSystemPrompt } from "../utils/systemPromptType"

let tempDir = ""
let originalProcessCwd = ""

beforeEach(async () => {
  originalProcessCwd = process.cwd()
  tempDir = await mkdtemp(join(tmpdir(), "query-yield-"))
  resetStateForTests()
  setOriginalCwd(tempDir)
  setCwdState(tempDir)
  setProjectRoot(tempDir)
  setConfigForTests({
    defaultModel: { source: "test", model: "claude-sonnet-4-5-20250929" },
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
  if (originalProcessCwd) process.chdir(originalProcessCwd)
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function createToolUseAssistantMessage(): AssistantMessage {
  return {
    type: "assistant",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: {
      id: "msg_tool_use",
      type: "message",
      role: "assistant",
      model: "test-model",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        {
          type: "tool_use",
          id: "toolu_yield_boundary",
          name: "MissingYieldBoundaryTool",
          input: {},
        },
      ],
    },
  } as unknown as AssistantMessage
}

function createToolUseContext(): any {
  let inProgressToolUseIds = new Set<string>()
  let responseLength = 0
  let appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    mcp: { tools: [], clients: [] },
    effortValue: undefined,
    advisorModel: undefined,
    sessionHooks: new Map(),
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: "test/claude-sonnet-4-5-20250929",
      tools: [],
      verbose: false,
      thinkingConfig: { type: "disabled" },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: (state: any) => any) => {
      appState = updater(appState as never)
    },
    setInProgressToolUseIDs: (updater: (state: Set<string>) => Set<string>) => {
      inProgressToolUseIds = updater(inProgressToolUseIds)
    },
    setResponseLength: (updater: (state: number) => number) => {
      responseLength = updater(responseLength)
    },
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as any
}

describe("query graceful yield", () => {
  test("returns yielded after tool results without a second model call", async () => {
    let callCount = 0
    const generator = query({
      messages: [createUserMessage({ content: "exercise graceful yield" })],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
      toolUseContext: createToolUseContext(),
      querySource: "sdk",
      maxTurns: 3,
      isYieldRequested: () => true,
      deps: {
        uuid: () => "query-yield-chain-id",
        microcompact: async (messages: unknown[]) => ({ messages }),
        autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
        callModel: async function* () {
          callCount++
          yield createToolUseAssistantMessage()
        },
      } as never,
    })

    const emitted: any[] = []
    let next = await generator.next()
    while (!next.done) {
      emitted.push(next.value)
      next = await generator.next()
    }

    expect(next.value.reason).toBe("yielded")
    expect(callCount).toBe(1)
    expect(
      emitted.some(
        (message) =>
          message.type === "user" &&
          Array.isArray(message.message?.content) &&
          message.message.content.some((block: { type?: string }) => block.type === "tool_result"),
      ),
    ).toBe(true)
  })
})

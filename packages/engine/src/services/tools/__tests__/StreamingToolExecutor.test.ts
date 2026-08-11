import { describe, expect, mock, test } from "bun:test"
import type { ToolUseBlock } from "@anthropic-ai/sdk/resources/index.mjs"
import { createAssistantMessage } from "../../../utils/messages.js"
import { getEmptyToolPermissionContext, type ToolUseContext } from "../../../Tool.js"

// Mock runToolUse to throw — isolates executor error handling from the real
// permission/abort/call chain. This tests ONLY that the executor converts a
// rejected generator into a failed tool_result with correct tool_use_id.
mock.module("../toolExecution.js", () => ({
  runToolUse: async function* () {
    throw new Error("edit backend stopped responding")
  },
}))

import { StreamingToolExecutor } from "../StreamingToolExecutor.js"

function makeMinimalContext(): ToolUseContext {
  const abortController = new AbortController()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: "test-model",
      tools: [],
      verbose: false,
      thinkingConfig: { type: "disabled" },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { builtinAgents: [], customAgents: [] },
    },
    abortController,
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () =>
      ({
        toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: "full" },
      }) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

const stubTool = {
  name: "FailingTool",
  inputSchema: { safeParse: (input: unknown) => ({ success: true, data: input }) },
  isConcurrencySafe: () => false,
} as any

const failingToolBlock: ToolUseBlock = {
  type: "tool_use",
  id: "tool_fail_1",
  name: "FailingTool",
  input: {},
}

describe("StreamingToolExecutor", () => {
  test("converts a rejected tool call into a failed tool result", async () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor(
      [stubTool],
      async () => ({ behavior: "allow" }) as any,
      {
        ...ctx,
        options: { ...ctx.options, tools: [stubTool] },
      },
    )
    executor.addTool(
      failingToolBlock,
      createAssistantMessage({
        content: [
          { type: "tool_use", id: failingToolBlock.id, name: failingToolBlock.name, input: {} },
        ],
      }),
    )

    const results: { message?: { message?: { content?: unknown[] } } }[] = []
    for await (const update of executor.getRemainingResults()) results.push(update)

    expect(results).toHaveLength(1)
    expect(results[0]?.message?.message?.content).toEqual([
      {
        type: "tool_result",
        content:
          "<tool_use_error>Error calling tool (FailingTool): edit backend stopped responding</tool_use_error>",
        is_error: true,
        tool_use_id: "tool_fail_1",
      },
    ])
  })
})

describe("StreamingToolExecutor.discard()", () => {
  test("clears the internal tools array", () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    const toolsBefore = (executor as unknown as { tools: unknown[] }).tools
    expect(toolsBefore).toHaveLength(0)

    executor.discard()

    const toolsAfter = (executor as unknown as { tools: unknown[] }).tools
    expect(toolsAfter).toHaveLength(0)
  })

  test("aborts the sibling abort controller", () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    const siblingController = (executor as unknown as { siblingAbortController: AbortController })
      .siblingAbortController
    expect(siblingController.signal.aborted).toBe(false)

    executor.discard()

    expect(siblingController.signal.aborted).toBe(true)
  })

  test("sets discarded flag so getCompletedResults yields nothing", () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const results = [...executor.getCompletedResults()]
    expect(results).toHaveLength(0)
  })

  test("sets discarded flag so getRemainingResults yields nothing", async () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const results: unknown[] = []
    for await (const update of executor.getRemainingResults()) {
      results.push(update)
    }
    expect(results).toHaveLength(0)
  })

  test("clears progressAvailableResolve", () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const resolve = (executor as unknown as { progressAvailableResolve?: () => void })
      .progressAvailableResolve
    expect(resolve).toBeUndefined()
  })

  test("can be called multiple times without error", () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    expect(() => {
      executor.discard()
      executor.discard()
      executor.discard()
    }).not.toThrow()
  })

  test("releases references to allow GC of discarded executor", () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const internals = executor as unknown as {
      tools: unknown[]
      progressAvailableResolve?: () => void
      turnSpan: unknown
    }
    expect(internals.tools).toHaveLength(0)
    expect(internals.progressAvailableResolve).toBeUndefined()
    expect(internals.turnSpan).toBeNull()
  })
})

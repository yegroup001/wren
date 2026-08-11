import { describe, expect, test } from "bun:test"
import type { ToolUseContext } from "src/Tool.js"

const { TaskOutputTool } = await import("../TaskOutputTool")
const { FileStateCache } = await import("src/utils/fileStateCache.js")

const mockContext = {
  abortController: new AbortController(),
  options: {
    tools: [],
    commands: [],
    debug: false,
    mainLoopModel: "test",
    verbose: false,
    thinkingConfig: { type: "disabled" as const },
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: true,
    agentDefinitions: { agents: [], byName: new Map() },
  },
  readFileState: new FileStateCache(100, 1024),
  getAppState: () => ({ tasks: {} }),
  setAppState: () => {},
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

const mockContextWithCompletedTask = {
  abortController: new AbortController(),
  options: {
    tools: [],
    commands: [],
    debug: false,
    mainLoopModel: "test",
    verbose: false,
    thinkingConfig: { type: "disabled" as const },
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: true,
    agentDefinitions: { agents: [], byName: new Map() },
  },
  readFileState: new FileStateCache(100, 1024),
  getAppState: () => ({
    tasks: {
      task_1: {
        id: "task_1",
        type: "local_agent",
        status: "completed",
        description: "test task",
        prompt: "hello",
        result: { content: [{ type: "text", text: "done" }] },
      },
    },
  }),
  setAppState: () => {},
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

describe("TaskOutputTool (headless)", () => {
  test("isEnabled returns true", () => {
    expect(TaskOutputTool.isEnabled()).toBe(true)
  })

  test("inputSchema accepts a task_id with defaults for block and timeout", () => {
    const result = TaskOutputTool.inputSchema.safeParse({
      task_id: "task_1",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.block).toBe(true)
      expect(result.data.timeout).toBe(30000)
    }
  })

  test("call throws when task_id does not exist", async () => {
    await expect(
      TaskOutputTool.call({ task_id: "missing", block: false, timeout: 30000 }, mockContext),
    ).rejects.toThrow("No task found with ID: missing")
  })

  test("call returns success for a completed task with block=false", async () => {
    const result = await TaskOutputTool.call(
      { task_id: "task_1", block: false, timeout: 30000 },
      mockContextWithCompletedTask,
    )
    expect(result.data.retrieval_status).toBe("success")
    expect(result.data.task).not.toBeNull()
    expect(result.data.task?.task_id).toBe("task_1")
    expect(result.data.task?.task_type).toBe("local_agent")
    expect(result.data.task?.status).toBe("completed")
    expect(result.data.task?.prompt).toBe("hello")
    expect(result.data.task?.output).toBe("done")
    expect(result.data.task?.result).toBe("done")
  })
})

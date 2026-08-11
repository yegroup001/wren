import { describe, expect, test } from "bun:test"
import type { ToolUseContext } from "src/Tool.js"

const { BashTool, resolveTimeoutMs } = await import("../BashTool")
const { FileStateCache } = await import("src/utils/fileStateCache.js")
const { getEmptyToolPermissionContext } = await import("src/Tool.js")
const { getMaxBashTimeoutMs } = await import("src/utils/timeouts.js")

// Skip AST-based command injection checks that require tree-sitter WASM.
process.env.WREN_DISABLE_COMMAND_INJECTION_CHECK = "1"

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
  getAppState: () => ({
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
  setAppState: () => {},
  messages: [],
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
} as unknown as ToolUseContext

const mockCanUseTool = (() =>
  Promise.resolve({
    behavior: "allow" as const,
    updatedInput: undefined,
  })) as unknown as Parameters<typeof BashTool.call>[2]

describe("BashTool (headless)", () => {
  test("isEnabled returns true", () => {
    expect(BashTool.isEnabled()).toBe(true)
  })

  test("inputSchema accepts a basic command", () => {
    const result = BashTool.inputSchema.safeParse({ command: "echo hello" })
    expect(result.success).toBe(true)
  })

  test("resolves omitted timeout to the configured default", () => {
    expect(resolveTimeoutMs()).toBeGreaterThan(0)
  })

  test("accepts a timeout at the configured maximum", () => {
    const maxTimeoutMs = getMaxBashTimeoutMs()
    expect(resolveTimeoutMs(maxTimeoutMs)).toBe(maxTimeoutMs)
  })

  test("rejects invalid timeout values", () => {
    expect(() => resolveTimeoutMs(-1)).toThrow()
    expect(() => resolveTimeoutMs(Number.NaN)).toThrow()
    expect(() => resolveTimeoutMs(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => resolveTimeoutMs(getMaxBashTimeoutMs() + 1)).toThrow()
  })

  test("call executes echo and returns stdout", async () => {
    const result = await BashTool.call({ command: "echo hello" }, mockContext, mockCanUseTool)
    expect(result.data.stdout.trim()).toBe("hello")
    expect(result.data.interrupted).toBe(false)
  })

  test("checkPermissions returns without throwing", async () => {
    const result = await BashTool.checkPermissions({ command: "rm -rf /" }, mockContext)
    expect(result).toBeDefined()
    expect(result.behavior).toBeDefined()
  })
})

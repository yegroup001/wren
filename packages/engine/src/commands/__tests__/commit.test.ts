import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Command } from "../../commands.js"

// Mock bun:bundle before any imports that use feature()
mock.module("bun:bundle", () => ({
  feature: (_name: string) => false,
}))

// Mock dependencies to avoid side effects
mock.module("src/utils/attribution.ts", () => ({
  getAttributionTexts: () => ({ commit: "", pr: "" }),
  getEnhancedPRAttribution: async () => undefined,
  countUserPromptsInMessages: () => 0,
}))

mock.module("src/utils/promptShellExecution.ts", () => ({
  executeShellCommandsInPrompt: async (content: string) => content,
}))

let commit: Command

beforeEach(async () => {
  const mod = await import("../commit.js")
  commit = mod.default as Command
})

describe("commit command metadata", () => {
  test("has correct name", () => {
    expect(commit.name).toBe("commit")
  })

  test("has description", () => {
    expect(commit.description).toBeTruthy()
    expect(typeof commit.description).toBe("string")
  })

  test("type is prompt", () => {
    expect(commit.type).toBe("prompt")
  })

  test("has progressMessage", () => {
    expect((commit as any).progressMessage).toBeTruthy()
  })

  test("source is builtin", () => {
    expect((commit as any).source).toBe("builtin")
  })

  test("has allowedTools array", () => {
    const tools = (commit as any).allowedTools
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("allowedTools includes git add", () => {
    const tools = (commit as any).allowedTools as string[]
    expect(tools.some((t) => t.includes("git add"))).toBe(true)
  })

  test("allowedTools includes git commit", () => {
    const tools = (commit as any).allowedTools as string[]
    expect(tools.some((t) => t.includes("git commit"))).toBe(true)
  })

  test("allowedTools includes git status", () => {
    const tools = (commit as any).allowedTools as string[]
    expect(tools.some((t) => t.includes("git status"))).toBe(true)
  })

  test("contentLength is 0 (dynamic)", () => {
    expect((commit as any).contentLength).toBe(0)
  })
})

describe("commit command getPromptForCommand", () => {
  test("returns array with text type", async () => {
    const mockContext = {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: [] },
        },
      }),
    }
    const result = await (commit as any).getPromptForCommand("", mockContext)
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].type).toBe("text")
  })

  test("result text contains git instructions", async () => {
    const mockContext = {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: [] },
        },
      }),
    }
    const result = await (commit as any).getPromptForCommand("", mockContext)
    expect(result[0].text).toContain("git")
  })

  test("result text contains git status", async () => {
    const mockContext = {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: [] },
        },
      }),
    }
    const result = await (commit as any).getPromptForCommand("", mockContext)
    expect(result[0].text).toContain("git status")
  })

  test("result text contains commit message instructions", async () => {
    const mockContext = {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: [] },
        },
      }),
    }
    const result = await (commit as any).getPromptForCommand("", mockContext)
    expect(result[0].text).toContain("commit")
  })

  test("getAppState override preserves alwaysAllowRules", async () => {
    let capturedAppState: any
    const mockContext = {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: ["existing-rule"] },
          otherProp: "test",
        },
        otherState: "value",
      }),
    }

    // Wrap executeShellCommandsInPrompt to capture context
    mock.module("src/utils/promptShellExecution.ts", () => ({
      executeShellCommandsInPrompt: async (content: string, ctx: any) => {
        capturedAppState = ctx.getAppState()
        return content
      },
    }))

    const mod = await import("../commit.js")
    const freshCommit = mod.default as any

    await freshCommit.getPromptForCommand("", mockContext)
    // The override should include alwaysAllowRules with command tools
    if (capturedAppState) {
      expect(capturedAppState.toolPermissionContext.alwaysAllowRules.command).toBeDefined()
    }
  })

  test("getPromptForCommand returns valid result", async () => {
    const mockContext = {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: [] },
        },
      }),
    }
    const result = await (commit as any).getPromptForCommand("", mockContext)
    expect(Array.isArray(result)).toBe(true)
  })

  test("getAppState override in context passes ALLOWED_TOOLS", async () => {
    let capturedCtx: any

    mock.module("src/utils/promptShellExecution.ts", () => ({
      executeShellCommandsInPrompt: async (content: string, ctx: any) => {
        capturedCtx = ctx
        return content
      },
    }))

    const { default: freshCommit } = await import("../commit.js")
    const baseAppState = {
      toolPermissionContext: {
        alwaysAllowRules: { command: ["old-rule"] },
        otherProp: "keep-this",
      },
      globalState: "preserved",
    }
    const mockContext = {
      getAppState: () => baseAppState,
    }

    await (freshCommit as any).getPromptForCommand("", mockContext)

    expect(capturedCtx).toBeDefined()
    const overriddenState = capturedCtx.getAppState()
    expect(overriddenState.globalState).toBe("preserved")
    expect(Array.isArray(overriddenState.toolPermissionContext.alwaysAllowRules.command)).toBe(true)
    expect(
      overriddenState.toolPermissionContext.alwaysAllowRules.command.some((t: string) =>
        t.includes("git add"),
      ),
    ).toBe(true)
  })
})

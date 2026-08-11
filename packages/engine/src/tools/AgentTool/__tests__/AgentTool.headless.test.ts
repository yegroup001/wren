import { describe, expect, test } from "bun:test"
import type { ToolUseContext } from "src/Tool.js"
import { AgentTool } from "../AgentTool.js"
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from "../constants.js"

describe("AgentTool headless", () => {
  test("isEnabled returns true", () => {
    expect(AgentTool.isEnabled()).toBe(true)
  })

  test("name is Agent", () => {
    expect(AgentTool.name).toBe("Agent")
  })

  test("aliases includes legacy name Task", () => {
    expect(AgentTool.aliases).toContain("Task")
  })

  test("maxResultSizeChars is 100000", () => {
    expect(AgentTool.maxResultSizeChars).toBe(100_000)
  })

  test("isReadOnly returns true", () => {
    expect(AgentTool.isReadOnly({ description: "x", prompt: "y" })).toBe(true)
  })

  test("isConcurrencySafe returns true", () => {
    expect(AgentTool.isConcurrencySafe({ description: "x", prompt: "y" })).toBe(true)
  })

  test("userFacingName returns Agent", () => {
    expect(AgentTool.userFacingName(undefined)).toBe("Agent")
  })

  test("toAutoClassifierInput includes subagent_type and prompt", () => {
    const result = AgentTool.toAutoClassifierInput({
      description: "test",
      prompt: "hello",
      subagent_type: "explore",
    })
    expect(result).toBe("explore: hello")
  })

  test("toAutoClassifierInput without subagent_type", () => {
    const result = AgentTool.toAutoClassifierInput({
      description: "test",
      prompt: "hello",
    })
    expect(result).toBe(": hello")
  })

  test("getActivityDescription returns description when present", () => {
    expect(
      AgentTool.getActivityDescription({
        description: "my task",
        prompt: "hello",
      }),
    ).toBe("my task")
  })

  test("getActivityDescription falls back to Running task", () => {
    expect(AgentTool.getActivityDescription(undefined)).toBe("Running task")
  })

  test("description returns a non-empty string", async () => {
    const desc = await AgentTool.description(
      { description: "x", prompt: "y" },
      {
        isNonInteractiveSession: false,
        toolPermissionContext: { mode: "default" },
        tools: [],
      },
    )
    expect(typeof desc).toBe("string")
    expect(desc.length).toBeGreaterThan(0)
  })

  test("prompt returns a non-empty string", async () => {
    const result = await AgentTool.prompt({
      agents: [],
      getToolPermissionContext: async () => ({ mode: "default" }),
      tools: [],
    })
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("Agent")
  })

  // ─── inputSchema tests ───

  test("inputSchema accepts valid input with required fields", () => {
    const result = AgentTool.inputSchema.safeParse({
      description: "test task",
      prompt: "hello",
    })
    expect(result.success).toBe(true)
  })

  test("inputSchema accepts all optional fields", () => {
    const result = AgentTool.inputSchema.safeParse({
      description: "test task",
      prompt: "hello",
      subagent_type: "explore",
      model: "sonnet",
      run_in_background: false,
    })
    expect(result.success).toBe(true)
  })

  test("inputSchema rejects missing description", () => {
    const result = AgentTool.inputSchema.safeParse({ prompt: "hello" })
    expect(result.success).toBe(false)
  })

  test("inputSchema rejects missing prompt", () => {
    const result = AgentTool.inputSchema.safeParse({
      description: "test task",
    })
    expect(result.success).toBe(false)
  })

  test("inputSchema rejects invalid model enum", () => {
    const result = AgentTool.inputSchema.safeParse({
      description: "test task",
      prompt: "hello",
      model: "invalid-model",
    })
    expect(result.success).toBe(false)
  })

  // ─── checkPermissions tests ───

  test("checkPermissions returns allow with updatedInput", async () => {
    const input = { description: "test task", prompt: "hello" }
    const result = await AgentTool.checkPermissions(input, {} as unknown as ToolUseContext)
    expect(result.behavior).toBe("allow")
    expect(result).toHaveProperty("updatedInput")
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(input)
    }
  })

  // ─── mapToolResultToToolResultBlockParam tests ───

  test("mapToolResultToToolResultBlockParam includes content and usage trailer for completed", () => {
    const data = {
      status: "completed" as const,
      prompt: "test prompt",
      content: [{ type: "text" as const, text: "result text" }],
      agentId: "agent_123",
      agentType: "general-purpose",
      totalToolUseCount: 5,
      totalDurationMs: 1000,
      totalTokens: 500,
    }
    const result = AgentTool.mapToolResultToToolResultBlockParam(data, "tu_1")
    expect(result.tool_use_id).toBe("tu_1")
    expect(result.type).toBe("tool_result")
    expect(Array.isArray(result.content)).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.text).toBe("result text")
    expect(content[1]!.text).toContain("agentId: agent_123")
    expect(content[1]!.text).toContain("total_tokens: 500")
    expect(content[1]!.text).toContain("tool_uses: 5")
    expect(content[1]!.text).toContain("duration_ms: 1000")
  })

  test("mapToolResultToToolResultBlockParam uses marker for empty content", () => {
    const data = {
      status: "completed" as const,
      prompt: "test prompt",
      content: [],
      agentId: "agent_456",
      agentType: "general-purpose",
      totalToolUseCount: 0,
      totalDurationMs: 100,
      totalTokens: 0,
    }
    const result = AgentTool.mapToolResultToToolResultBlockParam(data, "tu_2")
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toBe("(Subagent completed but returned no output.)")
    expect(content[1]!.text).toContain("agentId: agent_456")
  })

  test("mapToolResultToToolResultBlockParam skips trailer for one-shot agents", () => {
    for (const agentType of ONE_SHOT_BUILTIN_AGENT_TYPES) {
      const data = {
        status: "completed" as const,
        prompt: "test prompt",
        content: [{ type: "text" as const, text: "agent result" }],
        agentId: "agent_789",
        agentType,
        totalToolUseCount: 3,
        totalDurationMs: 500,
        totalTokens: 200,
      }
      const result = AgentTool.mapToolResultToToolResultBlockParam(data, "tu_3")
      const content = result.content as Array<{ type: string; text: string }>
      // One-shot agents get content + agentId trailer (no usage block)
      expect(content).toHaveLength(2)
      expect(content[0]!.text).toBe("agent result")
      expect(content[1]!.text).toBe("agentId: agent_789")
    }
  })

  test("mapToolResultToToolResultBlockParam includes trailer for non-one-shot agent", () => {
    const data = {
      status: "completed" as const,
      prompt: "test prompt",
      content: [{ type: "text" as const, text: "result" }],
      agentId: "agent_abc",
      agentType: "general-purpose",
      totalToolUseCount: 1,
      totalDurationMs: 200,
      totalTokens: 50,
    }
    const result = AgentTool.mapToolResultToToolResultBlockParam(data, "tu_4")
    const content = result.content as Array<{ type: string; text: string }>
    // general-purpose is NOT a one-shot agent — trailer should be present
    expect(content).toHaveLength(2)
    expect(content[1]!.text).toContain("agentId: agent_abc")
  })
})

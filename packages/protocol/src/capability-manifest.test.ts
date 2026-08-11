import { describe, expect, test } from "bun:test"
import {
  CapabilityManifestSchema,
  TOOL_DECISIONS,
  ToolAllowlistEntrySchema,
  ToolDecisionSchema,
} from "./capability-manifest"

describe("Todo 4: ToolAllowlistEntry / CapabilityManifest", () => {
  test("all ToolDecision values covered", () => {
    expect(TOOL_DECISIONS).toEqual(["allow", "defer", "isolate", "remove"])
    for (const d of TOOL_DECISIONS) {
      expect(ToolDecisionSchema.parse(d)).toBe(d)
    }
  })

  test("rejects unknown ToolDecision value", () => {
    expect(ToolDecisionSchema.safeParse("enable").success).toBe(false)
  })

  test("parses a ToolAllowlistEntry with allow decision", () => {
    const entry = ToolAllowlistEntrySchema.parse({
      toolName: "FileReadTool",
      decision: "allow",
      reason: "Core file reading capability",
    })

    expect(entry.toolName).toBe("FileReadTool")
    expect(entry.decision).toBe("allow")
  })

  test("parses a ToolAllowlistEntry with isolate decision", () => {
    const entry = ToolAllowlistEntrySchema.parse({
      toolName: "ArtifactTool",
      decision: "isolate",
      reason: "Remote artifact storage not supported",
    })

    expect(entry.decision).toBe("isolate")
  })

  test("rejects ToolAllowlistEntry with empty toolName", () => {
    const result = ToolAllowlistEntrySchema.safeParse({
      toolName: "",
      decision: "allow",
      reason: "x",
    })

    expect(result.success).toBe(false)
  })

  test("rejects ToolAllowlistEntry with empty reason", () => {
    const result = ToolAllowlistEntrySchema.safeParse({
      toolName: "WebSearchTool",
      decision: "remove",
      reason: "",
    })

    expect(result.success).toBe(false)
  })

  test("parses a full CapabilityManifest with 10 entries", () => {
    const manifest = CapabilityManifestSchema.parse({
      tools: Array.from({ length: 10 }, (_, i) => ({
        toolName: `Tool${i}`,
        decision: i % 2 === 0 ? "allow" : "defer",
        reason: `Decision for tool ${i}`,
      })),
      generatedAt: "2026-07-10T12:00:00.000Z",
      envSnapshot: {
        WREN_USE_OPENAI: "1",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: "sk-xxx",
      },
    })

    expect(manifest.tools).toHaveLength(10)
    expect(manifest.envSnapshot.WREN_USE_OPENAI).toBe("1")
    expect(manifest.envSnapshot.OPENAI_API_KEY).toBeUndefined()
  })

  test("parses a CapabilityManifest with empty tools array", () => {
    const manifest = CapabilityManifestSchema.parse({
      tools: [],
      generatedAt: "2026-07-10T12:00:00.000Z",
      envSnapshot: {},
    })

    expect(manifest.tools).toHaveLength(0)
  })

  test("rejects CapabilityManifest with invalid datetime", () => {
    const result = CapabilityManifestSchema.safeParse({
      tools: [],
      generatedAt: "not-a-date",
      envSnapshot: {},
    })

    expect(result.success).toBe(false)
  })
})

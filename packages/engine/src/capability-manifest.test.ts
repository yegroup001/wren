import { describe, expect, test } from "bun:test"
import type { CapabilityManifest, ToolAllowlistEntry } from "@wren/protocol"
import { getAllBaseTools, WREN_DEFAULT_TOOLS } from "./tools/index.js"
import { WREN_TOOL_CLASSIFICATIONS } from "./wren/engine.js"

describe("Todo 15: runtime capability manifest", () => {
  test("WREN_DEFAULT_TOOLS contains exactly 23 tools", () => {
    expect(WREN_DEFAULT_TOOLS).toHaveLength(23)
  })

  test("every allowlisted tool name exists in getAllBaseTools", () => {
    const allToolNames = new Set(getAllBaseTools().map((t) => t.name))
    for (const name of WREN_DEFAULT_TOOLS) {
      expect(allToolNames.has(name)).toBe(true)
    }
  })

  test("Agent IS in the default registry", () => {
    expect(WREN_DEFAULT_TOOLS.includes("Agent")).toBe(true)
  })

  test("WebSearch IS in the default registry", () => {
    expect(WREN_DEFAULT_TOOLS.includes("WebSearch")).toBe(true)
  })

  test("every tool in getAllBaseTools is classified", () => {
    const classifiedNames = new Set(WREN_TOOL_CLASSIFICATIONS.map((c) => c.toolName))
    const allToolNames = getAllBaseTools().map((t) => t.name)
    const unclassified = allToolNames.filter((name) => !classifiedNames.has(name))
    expect(unclassified).toEqual([])
  })

  test("every allowlisted tool has decision 'allow'", () => {
    for (const name of WREN_DEFAULT_TOOLS) {
      const entry = WREN_TOOL_CLASSIFICATIONS.find((c) => c.toolName === name)
      expect(entry).toBeDefined()
      expect(entry?.decision).toBe("allow")
    }
  })

  test("isolated tools are not in the default registry", () => {
    const isolated = WREN_TOOL_CLASSIFICATIONS.filter((c) => c.decision === "isolate")
    for (const entry of isolated) {
      expect(WREN_DEFAULT_TOOLS.includes(entry.toolName)).toBe(false)
    }
  })

  test("removed tools are not in the default registry", () => {
    const removed = WREN_TOOL_CLASSIFICATIONS.filter((c) => c.decision === "remove")
    for (const entry of removed) {
      expect(WREN_DEFAULT_TOOLS.includes(entry.toolName)).toBe(false)
    }
  })

  test("can generate a CapabilityManifest from classifications", () => {
    const manifest: CapabilityManifest = {
      tools: WREN_TOOL_CLASSIFICATIONS,
      generatedAt: new Date().toISOString(),
      envSnapshot: {
        WREN_USE_OPENAI: process.env.WREN_USE_OPENAI,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY !== undefined ? "***" : undefined,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY !== undefined ? "***" : undefined,
      },
    }

    expect(manifest.tools.length).toBeGreaterThan(30)
    expect(manifest.tools.filter((t) => t.decision === "allow")).toHaveLength(23)
  })
})

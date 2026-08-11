import { z } from "zod"

// ---------------------------------------------------------------------------
// ToolAllowlistEntry — per-tool decision in the deny-by-default registry
// ---------------------------------------------------------------------------

export const TOOL_DECISIONS = ["allow", "defer", "isolate", "remove"] as const
export type ToolDecision = (typeof TOOL_DECISIONS)[number]
export const ToolDecisionSchema = z.enum(TOOL_DECISIONS)

export const ToolAllowlistEntrySchema = z.object({
  toolName: z.string().min(1),
  decision: ToolDecisionSchema,
  reason: z.string().min(1),
})

export type ToolAllowlistEntry = z.infer<typeof ToolAllowlistEntrySchema>

// ---------------------------------------------------------------------------
// CapabilityManifest — runtime snapshot of tool registration
// ---------------------------------------------------------------------------

export const CapabilityManifestSchema = z.object({
  tools: z.array(ToolAllowlistEntrySchema).readonly(),
  generatedAt: z.string().datetime(),
  envSnapshot: z.record(z.string(), z.union([z.string(), z.undefined()])),
})

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>

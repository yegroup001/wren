import { z } from "zod"

// ---------------------------------------------------------------------------
// ProviderKind — discriminates provider API shape families
// ---------------------------------------------------------------------------

export const PROVIDER_KINDS = [
  "anthropic",
  "openai-official",
  "openai-compatible-chat",
  "gemini",
  "grok",
] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const ProviderKindSchema = z.enum(PROVIDER_KINDS)

// ---------------------------------------------------------------------------
// ProviderIdentity — typed metadata about a resolved provider
// ---------------------------------------------------------------------------

export const ProviderIdentitySchema = z.object({
  providerId: z.string().min(1),
  kind: ProviderKindSchema,
  displayName: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  authEnv: z.array(z.string().min(1)).readonly(),
  source: z.enum(["env", "config", "builtin"]),
})

export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>

// ---------------------------------------------------------------------------
// ModelRef — opaque, nested-slash-safe model reference
// ---------------------------------------------------------------------------

export const ModelRefSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1).optional(),
})

export type ModelRef = z.infer<typeof ModelRefSchema>

// ---------------------------------------------------------------------------
// ModelScope / ModelSource / VerifiedState
// ---------------------------------------------------------------------------

export const MODEL_SCOPES = ["turn", "session", "workspace", "user"] as const
export type ModelScope = (typeof MODEL_SCOPES)[number]
export const ModelScopeSchema = z.enum(MODEL_SCOPES)

export const MODEL_SOURCES = [
  "slash-command",
  "picker",
  "cli",
  "session",
  "workspace-config",
  "user-config",
  "env",
  "builtin",
] as const
export type ModelSource = (typeof MODEL_SOURCES)[number]
export const ModelSourceSchema = z.enum(MODEL_SOURCES)

export const VERIFIED_STATES = ["unverified", "probe-ok", "probe-failed", "request-ok"] as const
export type VerifiedState = (typeof VERIFIED_STATES)[number]
export const VerifiedStateSchema = z.enum(VERIFIED_STATES)

// ---------------------------------------------------------------------------
// Reasoning mechanism — how each provider kind controls thinking
// ---------------------------------------------------------------------------

export const REASONING_MECHANISMS = [
  "effort-levels",
  "thinking-budget",
  "reasoning-mode",
  "thinking-toggle",
  "none",
] as const

export type ReasoningMechanism = (typeof REASONING_MECHANISMS)[number]

export const ReasoningMechanismSchema = z.enum(REASONING_MECHANISMS)

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export const EffortLevelSchema = z.enum(EFFORT_LEVELS)

export const SelectedModelReferenceSchema = z.object({
  source: z.string().min(1),
  model: z.string().min(1),
  effort: EffortLevelSchema.optional(),
})

export type SelectedModelReference = z.infer<typeof SelectedModelReferenceSchema>

export const REASONING_MODES = ["adaptive", "budget"] as const
export type ReasoningMode = (typeof REASONING_MODES)[number]
export const ReasoningModeSchema = z.enum(REASONING_MODES)

// ---------------------------------------------------------------------------
// TaskModelKey — classification of internal/subagent side-query API calls
// ---------------------------------------------------------------------------
// taskModels classifies the internal side queries the engine itself issues
// (memory scans, permission classifiers, compacting, title generation, web
// search, attachment summaries, hook workers) onto explicit model references.
// Unspecified task classes use defaultModel.

export const TASK_MODEL_KEYS = [
  "memory",
  "classifier",
  "compact",
  "title",
  "websearch",
  "permission-explainer",
  "attachment-summary",
  "hook",
] as const
export type TaskModelKey = (typeof TASK_MODEL_KEYS)[number]
export const TaskModelKeySchema = z.enum(TASK_MODEL_KEYS)

export type ProviderKindReasoningCapability = {
  readonly mechanism: ReasoningMechanism
  readonly effortLevels: readonly EffortLevel[]
  readonly runtimeSwitchable: boolean
}

export const ProviderKindReasoningCapabilities: Record<
  ProviderKind,
  ProviderKindReasoningCapability
> = {
  anthropic: {
    mechanism: "reasoning-mode",
    effortLevels: [],
    runtimeSwitchable: true,
  },
  "openai-official": {
    mechanism: "effort-levels",
    effortLevels: EFFORT_LEVELS,
    runtimeSwitchable: true,
  },
  "openai-compatible-chat": {
    mechanism: "effort-levels",
    effortLevels: EFFORT_LEVELS,
    runtimeSwitchable: true,
  },
  gemini: {
    mechanism: "thinking-budget",
    effortLevels: [],
    runtimeSwitchable: true,
  },
  grok: {
    mechanism: "effort-levels",
    effortLevels: EFFORT_LEVELS,
    runtimeSwitchable: true,
  },
}

// ---------------------------------------------------------------------------
// ReasoningOptions — discriminated union per provider kind
// ---------------------------------------------------------------------------

export const ReasoningOptionsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("anthropic"),
    mode: z.enum(["adaptive", "budget"]),
    budgetTokens: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("openai-responses"),
    effort: z.enum(["low", "medium", "high", "xhigh"]),
  }),
  z.object({
    kind: z.literal("openai-chat-vendor"),
    enableThinking: z.boolean(),
  }),
  z.object({
    kind: z.literal("gemini"),
    includeThoughts: z.boolean(),
    thinkingBudget: z.number().int().nonnegative().optional(),
  }),
])

export type ReasoningOptions = z.infer<typeof ReasoningOptionsSchema>

// ---------------------------------------------------------------------------
// ModelSelection — full model selection record
// ---------------------------------------------------------------------------

export const ModelSelectionSchema = z.object({
  ref: ModelRefSchema,
  scope: ModelScopeSchema,
  source: ModelSourceSchema,
  reasoning: ReasoningOptionsSchema.optional(),
  verified: VerifiedStateSchema,
})

export type ModelSelection = z.infer<typeof ModelSelectionSchema>

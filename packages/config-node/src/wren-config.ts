import { existsSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  EffortLevelSchema,
  type ProviderKind,
  ProviderKindReasoningCapabilities,
  ProviderKindSchema,
  ReasoningModeSchema,
  SelectedModelReferenceSchema,
  TASK_MODEL_KEYS,
  type TaskModelKey,
} from "@wren/protocol"
import { z } from "zod"
import { getWrenConfigHome } from "./config-home"

const ApiKeySchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
    if (val.startsWith("$")) {
      const envName = val.slice(1)
      const resolved = process.env[envName]
      if (!resolved) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Environment variable "${envName}" is not set`,
        })
        return z.NEVER
      }
      return resolved
    }
    return val
  })

export const WrenProviderSchema = z.object({
  type: ProviderKindSchema,
  baseUrl: z.string().url().optional(),
  apiKey: ApiKeySchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

export type WrenProvider = z.infer<typeof WrenProviderSchema>

export const WrenModelSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  displayName: z.string().min(1).optional(),
  supportsThinking: z.boolean().default(false),
  /** Default effort level for this model. Only valid for models whose provider kind uses effort levels. */
  effort: EffortLevelSchema.optional(),
  /** Explicit array of supported effort levels. If omitted, derived from supportsThinking + provider kind. */
  efforts: z.array(EffortLevelSchema).optional(),
  /** Token budget for Gemini thinking. Only valid for gemini provider kind. Mutually exclusive with effort/efforts. */
  thinkingBudget: z.number().int().nonnegative().optional(),
  /** Reasoning mode for Anthropic. Only valid for anthropic provider kind. Mutually exclusive with effort/efforts/thinkingBudget. */
  reasoningMode: ReasoningModeSchema.optional(),
  /** Optional token budget when reasoningMode is "budget". */
  budgetTokens: z.number().int().positive().optional(),
  /** Boolean thinking toggle for OpenAI-compatible models that use toggle instead of effort levels (e.g., DeepSeek, MiMo). Only valid for openai-compatible-chat. Mutually exclusive with effort/efforts. */
  enableThinking: z.boolean().optional(),
  /** Ordered list of model IDs to try if this model is unavailable (rate limit, 5xx, etc.) */
  fallback: z.array(z.string().min(1)).optional(),
})

export type WrenModel = z.infer<typeof WrenModelSchema>

export const WrenSourceSchema = WrenProviderSchema.extend({
  models: z.record(z.string().min(1), WrenModelSchema),
})

export type WrenSource = z.infer<typeof WrenSourceSchema>

export const WrenConfigSchema = z
  .object({
    defaultModel: SelectedModelReferenceSchema,
    sources: z.record(z.string().min(1), WrenSourceSchema),
    // Behavioral preferences previously read from the vendored engine's
    // legacy global config (~/.wren/.wren.json). Kept here so user-facing
    // options live in the single config.json.
    theme: z.enum(["auto", "dark", "light"]).optional(),
    autoCompact: z.boolean().optional(),
    preferredLanguage: z.enum(["auto", "en", "zh"]).optional(),
    // Per-agentType model override. Value is an explicit { source, model, effort? }
    // reference; omitting an agentType uses defaultModel.
    agentModels: z
      .record(z.string().min(1), SelectedModelReferenceSchema)
      .optional(),
    // Per-task model override for the engine's internal side-query API calls
    // (memory scans, permission classifiers, compacting, title generation, web
    // search, attachment summaries, hook workers). Value is an explicit
    // { source, model, effort? } reference; omitting a task uses defaultModel.
    taskModels: z
      .record(z.string().min(1), SelectedModelReferenceSchema)
      .optional(),
    // LSP servers: `false` disables all LSP (including plugin-provided
    // servers); an object adds user-defined servers keyed by name; `true`
    // (or omitted) means plugin-provided LSP servers are loaded as usual.
    // `true` is accepted so configs written for opencode-style `lsp: true`
    // don't fail validation and brick startup.
    lsp: z
      .union([
        z.literal(true),
        z.literal(false),
        z.record(
          z.string().min(1),
          z.object({
            command: z
              .string()
              .min(1)
              .refine(
                (cmd) => {
                  // Commands with spaces should use args array instead
                  if (cmd.includes(" ") && !cmd.startsWith("/")) {
                    return false
                  }
                  return true
                },
                { message: "Command should not contain spaces. Use args array for arguments." },
              ),
            args: z.array(z.string()).optional(),
            extensionToLanguage: z
              .record(z.string().min(1), z.string().min(1))
              .refine((record) => Object.keys(record).length > 0, {
                message: "extensionToLanguage must have at least one mapping",
              }),
            env: z.record(z.string(), z.string()).optional(),
            transport: z.enum(["stdio", "socket"]).optional(),
            initializationOptions: z.unknown().optional(),
          }),
        ),
      ])
      .optional(),
    mcpServers: z
      .record(
        z.string().min(1),
        z.object({
          type: z.string().optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          headersHelper: z.string().optional(),
          ideName: z.string().optional(),
          authToken: z.string().optional(),
          ideRunningInWindows: z.boolean().optional(),
          oauth: z
            .object({
              clientId: z.string().optional(),
              callbackPort: z.number().int().positive().optional(),
              authServerMetadataUrl: z.string().optional(),
              xaa: z.boolean().optional(),
            })
            .optional(),
          name: z.string().optional(),
          id: z.string().optional(),
        }),
      )
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [, source] of Object.entries(config.sources)) {
      const kind = source.type as ProviderKind
      const caps = ProviderKindReasoningCapabilities[kind]
      for (const [modelId, model] of Object.entries(source.models)) {
        const hasEffort = model.effort !== undefined || model.efforts !== undefined
        const hasThinkingBudget = model.thinkingBudget !== undefined
        const hasReasoningMode = model.reasoningMode !== undefined
        const hasEnableThinking = model.enableThinking !== undefined

        // If supportsThinking is false, all thinking fields must be absent
        if (!model.supportsThinking) {
          const thinkingFields: Array<[string, boolean]> = [
            ["effort", model.effort !== undefined],
            ["efforts", model.efforts !== undefined],
            ["thinkingBudget", hasThinkingBudget],
            ["reasoningMode", hasReasoningMode],
            ["enableThinking", hasEnableThinking],
          ]
          for (const [field, present] of thinkingFields) {
            if (present) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, field],
                message: `"${field}" cannot be set when supportsThinking is false`,
              })
            }
          }
          continue
        }

        // Validate thinking fields against provider kind
        switch (caps.mechanism) {
          case "effort-levels": {
            // effort/efforts are allowed; thinkingBudget, reasoningMode, enableThinking are not
            if (hasThinkingBudget) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "thinkingBudget"],
                message: `thinkingBudget is not valid for provider kind "${kind}" (uses effort-levels)`,
              })
            }
            if (hasReasoningMode) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "reasoningMode"],
                message: `reasoningMode is not valid for provider kind "${kind}" (uses effort-levels)`,
              })
            }
            if (model.budgetTokens !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "budgetTokens"],
                message: `budgetTokens is not valid for provider kind "${kind}" (uses effort-levels)`,
              })
            }
            // enableThinking is valid only for openai-compatible-chat to switch mechanism to thinking-toggle
            if (hasEnableThinking && kind !== "openai-compatible-chat") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "enableThinking"],
                message: `enableThinking is not valid for provider kind "${kind}"`,
              })
            }
            // If enableThinking is set, effort/efforts must not be set (mutually exclusive)
            if (hasEnableThinking && hasEffort) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "enableThinking"],
                message: `enableThinking and effort/efforts are mutually exclusive`,
              })
            }
            // effort must be in efforts if both specified
            if (model.effort !== undefined && model.efforts !== undefined) {
              if (!model.efforts.includes(model.effort)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["models", modelId, "effort"],
                  message: `effort "${model.effort}" must be in efforts [${model.efforts.join(", ")}]`,
                })
              }
            }
            // Reject empty efforts array — it's nonsensical for a model that
            // uses effort levels but supports none
            if (model.efforts !== undefined && model.efforts.length === 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "efforts"],
                message: `efforts cannot be empty for a model that uses effort levels`,
              })
            }
            break
          }
          case "thinking-budget": {
            // thinkingBudget is allowed; effort/efforts, reasoningMode, enableThinking are not
            if (hasEffort) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId],
                message: `effort/efforts are not valid for provider kind "${kind}" (uses thinking-budget)`,
              })
            }
            if (hasReasoningMode) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "reasoningMode"],
                message: `reasoningMode is not valid for provider kind "${kind}" (uses thinking-budget)`,
              })
            }
            if (hasEnableThinking) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "enableThinking"],
                message: `enableThinking is not valid for provider kind "${kind}"`,
              })
            }
            if (model.budgetTokens !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "budgetTokens"],
                message: `budgetTokens is not valid for provider kind "${kind}" (uses thinking-budget)`,
              })
            }
            break
          }
          case "reasoning-mode": {
            // reasoningMode is allowed; effort/efforts, thinkingBudget, enableThinking are not
            if (hasEffort) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId],
                message: `effort/efforts are not valid for provider kind "${kind}" (uses reasoning-mode)`,
              })
            }
            if (hasThinkingBudget) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "thinkingBudget"],
                message: `thinkingBudget is not valid for provider kind "${kind}" (uses reasoning-mode)`,
              })
            }
            if (hasEnableThinking) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "enableThinking"],
                message: `enableThinking is not valid for provider kind "${kind}"`,
              })
            }
            // budgetTokens only valid when reasoningMode is "budget"
            if (model.budgetTokens !== undefined && model.reasoningMode !== "budget") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "budgetTokens"],
                message: `budgetTokens is only valid when reasoningMode is "budget"`,
              })
            }
            break
          }
          case "thinking-toggle": {
            // enableThinking is allowed; effort/efforts, thinkingBudget, reasoningMode are not
            if (hasEffort) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId],
                message: `effort/efforts are not valid for provider kind "${kind}" (uses thinking-toggle)`,
              })
            }
            if (hasThinkingBudget) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "thinkingBudget"],
                message: `thinkingBudget is not valid for provider kind "${kind}" (uses thinking-toggle)`,
              })
            }
            if (hasReasoningMode) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "reasoningMode"],
                message: `reasoningMode is not valid for provider kind "${kind}" (uses thinking-toggle)`,
              })
            }
            if (model.budgetTokens !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["models", modelId, "budgetTokens"],
                message: `budgetTokens is not valid for provider kind "${kind}" (uses thinking-toggle)`,
              })
            }
            break
          }
          default: {
            // mechanism is "none" — no thinking fields are valid
            const allThinkingFields: Array<[string, boolean]> = [
              ["effort", model.effort !== undefined],
              ["efforts", model.efforts !== undefined],
              ["thinkingBudget", hasThinkingBudget],
              ["reasoningMode", hasReasoningMode],
              ["budgetTokens", model.budgetTokens !== undefined],
              ["enableThinking", hasEnableThinking],
            ]
            for (const [field, present] of allThinkingFields) {
              if (present) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["models", modelId, field],
                  message: `"${field}" is not valid for provider kind "${kind}" (uses none)`,
                })
              }
            }
            break
          }
        }
      }
    }
    const validateReference = (
      reference: {
        readonly source: string
        readonly model: string
        readonly effort?: z.infer<typeof EffortLevelSchema> | undefined
      },
      path: readonly (string | number)[],
    ): void => {
      const source = config.sources[reference.source]
      if (source === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "source"],
          message: `source "${reference.source}" not found`,
        })
        return
      }
      const model = source.models[reference.model]
      if (model === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "model"],
          message: `model "${reference.model}" not found in source "${reference.source}"`,
        })
        return
      }
      if (reference.effort === undefined) return
      if (!model.supportsThinking) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "effort"],
          message: `model "${reference.model}" in source "${reference.source}" does not support effort`,
        })
        return
      }
      if (model.efforts !== undefined && !model.efforts.includes(reference.effort)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "effort"],
          message: `effort "${reference.effort}" is not supported by model "${reference.model}" in source "${reference.source}"`,
        })
      }
    }

    validateReference(config.defaultModel, ["defaultModel"])
    for (const [agentType, reference] of Object.entries(config.agentModels ?? {})) {
      validateReference(reference, ["agentModels", agentType])
    }
    for (const [taskKey, reference] of Object.entries(config.taskModels ?? {})) {
      if (!TASK_MODEL_KEYS.includes(taskKey as TaskModelKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskModels", taskKey],
          message: `task key "${taskKey}" is not a recognized task class (${TASK_MODEL_KEYS.join(", ")})`,
        })
        continue
      }
      validateReference(reference, ["taskModels", taskKey])
    }
  })

export type WrenConfig = z.infer<typeof WrenConfigSchema>

export type WrenConfigLoadResult =
  | { readonly success: true; readonly config: WrenConfig }
  | { readonly success: false; readonly error: string }

export function getConfigPaths(explicitPath?: string, cwd?: string): readonly string[] {
  if (explicitPath !== undefined) return [explicitPath]
  const paths: string[] = []
  if (cwd !== undefined) {
    paths.push(join(cwd, ".wren", "config.json"))
  }
  paths.push(join(getWrenConfigHome(), "config.json"))
  return paths
}

export async function loadWrenConfig(
  configPath?: string,
  cwd?: string,
): Promise<WrenConfigLoadResult> {
  const paths = getConfigPaths(configPath, cwd)
  let baseConfig: Record<string, unknown> | null = null
  let lastError: string | null = null

  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const text = await readFile(p, "utf8")
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (baseConfig === null) {
        baseConfig = parsed
      } else {
        baseConfig = deepMerge(baseConfig, parsed) as Record<string, unknown>
      }
    } catch (error) {
      lastError = `Failed to read config ${p}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (baseConfig === null) {
    return {
      success: false,
      error:
        lastError ??
        `No config file found at ~/.wren/config.json. Create one — see .wren-config.example.json for the format.`,
    }
  }

  const result = WrenConfigSchema.safeParse(baseConfig)
  if (result.success) {
    return { success: true, config: result.data }
  }
  const legacyKeys = ["providers", "models", "aliases"].filter((key) => key in baseConfig)
  const migrationGuidance =
    legacyKeys.length === 0
      ? ""
      : ` Legacy config format detected (${legacyKeys.join(", ")}). Move provider definitions and their models under sources.<source>.models, use { source, model } for defaultModel, agentModels, and taskModels.`
  return {
    success: false,
    error: `Config validation failed:${migrationGuidance} ${result.error.issues.map((i) => i.message).join(", ")}`,
  }
}

/**
 * Apply a shallow top-level patch to the user config (~/.wren/config.json).
 * Validates the merged result BEFORE writing, so a bad patch never corrupts
 * the file on disk. Returns the re-validated config on success.
 *
 * Only the user home config is written — workspace .wren/config.json is
 * project-scoped and never modified by the app. Fails (no write) when no
 * user config file exists yet, letting callers fall back to the legacy
 * ~/.wren/.wren.json store.
 */
export async function patchWrenUserConfig(
  patch: Record<string, unknown>,
): Promise<WrenConfigLoadResult> {
  const userConfigPath = join(getWrenConfigHome(), "config.json")
  if (!existsSync(userConfigPath)) {
    return { success: false, error: "No user config file found" }
  }

  let base: Record<string, unknown>
  try {
    base = JSON.parse(await readFile(userConfigPath, "utf8")) as Record<string, unknown>
  } catch (error) {
    return {
      success: false,
      error: `Failed to read config: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const merged = { ...base, ...patch }
  const result = WrenConfigSchema.safeParse(merged)
  if (!result.success) {
    return {
      success: false,
      error: `Config validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
    }
  }

  const tmpPath = `${userConfigPath}.${process.pid}.tmp`
  try {
    await writeFile(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
    await rename(tmpPath, userConfigPath)
  } catch (error) {
    return {
      success: false,
      error: `Failed to write config: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { success: true, config: result.data }
}

/**
 * Deep merge two config objects. Nested records (models, providers, etc.)
 * are merged key-by-key rather than replaced. Arrays and scalars are
 * replaced by the source value (not concatenated).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else {
      result[key] = value
    }
  }
  return result
}

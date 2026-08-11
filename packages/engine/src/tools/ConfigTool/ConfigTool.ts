import { buildTool, type ToolDef } from "src/Tool.js"
import {
  type GlobalConfig,
  getGlobalConfig,
  saveGlobalConfig,
} from "src/utils/config.js"
import { errorMessage } from "src/utils/errors.js"
import { lazySchema } from "src/utils/lazySchema.js"
import { logError } from "src/utils/log.js"
import { getInitialSettings, updateSettingsForSource } from "src/utils/settings/settings.js"
import { jsonStringify } from "src/utils/slowOperations.js"
import { z } from "zod/v4"
import { CONFIG_TOOL_NAME } from "./constants.js"
import { DESCRIPTION, generatePrompt } from "./prompt.js"
import { getConfig, getOptionsForSetting, getPath, isSupported } from "./supportedSettings.js"

const inputSchema = lazySchema(() =>
  z.strictObject({
    setting: z
      .string()
      .describe('The setting key (e.g., "theme", "model", "permissions.defaultMode")'),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe("The new value. Omit to get current value."),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    operation: z.enum(["get", "set"]).optional(),
    setting: z.string().optional(),
    value: z.unknown().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,
  searchHint: "get or set Wren settings (theme, model)",
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return "Config"
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input: Input) {
    return input.value === undefined
  },
  toAutoClassifierInput(input) {
    return input.value === undefined ? input.setting : `${input.setting} = ${input.value}`
  },
  async checkPermissions(input: Input) {
    // Auto-allow reading configs
    if (input.value === undefined) {
      return { behavior: "allow" as const, updatedInput: input }
    }
    return {
      behavior: "ask" as const,
      message: `Set ${input.setting} to ${jsonStringify(input.value)}`,
    }
  },
  async call({ setting, value }: Input, context): Promise<{ data: Output }> {
    // 1. Check if setting is supported
    if (!isSupported(setting)) {
      return {
        data: { success: false, error: `Unknown setting: "${setting}"` },
      }
    }

    const config = getConfig(setting)!
    const path = getPath(setting)

    // 2. GET operation
    if (value === undefined) {
      const currentValue = getValue(config.source, path)
      const displayValue = config.formatOnRead ? config.formatOnRead(currentValue) : currentValue
      return {
        data: { success: true, operation: "get", setting, value: displayValue },
      }
    }

    // 3. SET operation

    let finalValue: unknown = value

    // Coerce and validate boolean values
    if (config.type === "boolean") {
      if (typeof value === "string") {
        const lower = value.toLowerCase().trim()
        if (lower === "true") finalValue = true
        else if (lower === "false") finalValue = false
      }
      if (typeof finalValue !== "boolean") {
        return {
          data: {
            success: false,
            operation: "set",
            setting,
            error: `${setting} requires true or false.`,
          },
        }
      }
    }

    // Check options
    const options = getOptionsForSetting(setting)
    if (options && !options.includes(String(finalValue))) {
      return {
        data: {
          success: false,
          operation: "set",
          setting,
          error: `Invalid value "${value}". Options: ${options.join(", ")}`,
        },
      }
    }

    // Async validation (e.g., model API check)
    if (config.validateOnWrite) {
      const result = await config.validateOnWrite(finalValue)
      if (!result.valid) {
        return {
          data: {
            success: false,
            operation: "set",
            setting,
            error: result.error,
          },
        }
      }
    }

    const previousValue = getValue(config.source, path)

    // 4. Write to storage
    try {
      if (config.source === "global") {
        const key = path[0]
        if (!key) {
          return {
            data: {
              success: false,
              operation: "set",
              setting,
              error: "Invalid setting path",
            },
          }
        }
        saveGlobalConfig((prev) => {
          if (prev[key as keyof GlobalConfig] === finalValue) return prev
          return { ...prev, [key]: finalValue }
        })
      } else {
        const update = buildNestedObject(path, finalValue)
        const result = updateSettingsForSource("userSettings", update)
        if (result.error) {
          return {
            data: {
              success: false,
              operation: "set",
              setting,
              error: result.error.message,
            },
          }
        }
      }

      // 5b. Sync to AppState if needed for immediate UI effect
      if (config.appStateKey) {
        const appKey = config.appStateKey
        context.setAppState((prev) => {
          if (prev[appKey] === finalValue) return prev
          return { ...prev, [appKey]: finalValue }
        })
      }

      return {
        data: {
          success: true,
          operation: "set",
          setting,
          previousValue,
          newValue: finalValue,
        },
      }
    } catch (error) {
      logError(error)
      return {
        data: {
          success: false,
          operation: "set",
          setting,
          error: errorMessage(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.success) {
      if (content.operation === "get") {
        return {
          tool_use_id: toolUseID,
          type: "tool_result" as const,
          content: `${content.setting} = ${jsonStringify(content.value)}`,
        }
      }
      return {
        tool_use_id: toolUseID,
        type: "tool_result" as const,
        content: `Set ${content.setting} to ${jsonStringify(content.newValue)}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: "tool_result" as const,
      content: `Error: ${content.error}`,
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function getValue(source: "global" | "settings", path: string[]): unknown {
  if (source === "global") {
    const config = getGlobalConfig()
    const key = path[0]
    if (!key) return undefined
    return config[key as keyof GlobalConfig]
  }
  const settings = getInitialSettings()
  let current: unknown = settings
  for (const key of path) {
    if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function buildNestedObject(path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) {
    return {}
  }
  const key = path[0]!
  if (path.length === 1) {
    return { [key]: value }
  }
  return { [key]: buildNestedObject(path.slice(1), value) }
}

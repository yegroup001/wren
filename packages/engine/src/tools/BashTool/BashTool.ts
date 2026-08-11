import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs"
import { buildTool, type ToolDef } from "src/Tool.js"
import type { PermissionResult } from "src/types/permissions.js"
import { lazySchema } from "src/utils/lazySchema.js"
import { exec } from "src/utils/Shell.js"
import { z } from "zod/v4"
import { bashToolHasPermission, commandHasAnyCd } from "./bashPermissions.js"
import { getDefaultTimeoutMs, getMaxTimeoutMs, getSimplePrompt } from "./prompt.js"
import { checkReadOnlyConstraints } from "./readOnlyValidation.js"
import { shouldUseSandbox } from "./shouldUseSandbox.js"
import { BASH_TOOL_NAME } from "./toolName.js"

const MAX_RESULT_SIZE_CHARS = 30_000

export function resolveTimeoutMs(timeout?: number): number {
  if (timeout === undefined) {
    return getDefaultTimeoutMs()
  }
  const maxTimeoutMs = getMaxTimeoutMs()
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > maxTimeoutMs) {
    throw new Error(`Bash timeout must be between 0 and ${maxTimeoutMs} milliseconds`)
  }
  return timeout
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe("The command to execute"),
    timeout: z
      .number()
      .optional()
      .describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
    description: z
      .string()
      .optional()
      .describe("Clear, concise description of what this command does"),
    dangerouslyDisableSandbox: z
      .boolean()
      .optional()
      .describe("Set this to true to dangerously override sandbox mode."),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    stdout: z.string(),
    stderr: z.string(),
    interrupted: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type BashToolInput = z.infer<InputSchema>

export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  async description(input) {
    return input.description || "Run shell command"
  },

  async prompt() {
    return getSimplePrompt()
  },

  userFacingName() {
    return "Bash"
  },

  toAutoClassifierInput(input) {
    return input.command
  },

  isReadOnly(input): boolean {
    return checkReadOnlyConstraints(input, commandHasAnyCd(input.command)).behavior === "allow"
  },

  isConcurrencySafe(input): boolean {
    return checkReadOnlyConstraints(input, commandHasAnyCd(input.command)).behavior === "allow"
  },

  async checkPermissions(input, context): Promise<PermissionResult> {
    return bashToolHasPermission(input, context)
  },

  async call(args, context) {
    const { command, timeout } = args
    const timeoutMs = resolveTimeoutMs(timeout)

    const sandbox = shouldUseSandbox({
      command,
      dangerouslyDisableSandbox: args.dangerouslyDisableSandbox,
    })

    const shellCommand = await exec(command, context.abortController.signal, "bash", {
      timeout: timeoutMs,
      shouldUseSandbox: sandbox,
    })

    try {
      const result = await shellCommand.result

      return {
        data: {
          stdout: result.stdout.slice(0, MAX_RESULT_SIZE_CHARS),
          stderr: result.stderr.slice(0, MAX_RESULT_SIZE_CHARS),
          interrupted: result.interrupted,
        },
      }
    } finally {
      shellCommand.cleanup()
    }
  },

  mapToolResultToToolResultBlockParam(data, toolUseID): ToolResultBlockParam {
    return {
      type: "tool_result",
      content: [data.stdout, data.stderr].filter(Boolean).join("\n"),
      tool_use_id: toolUseID,
      is_error: data.interrupted,
    }
  },

} satisfies ToolDef<InputSchema, Output>)

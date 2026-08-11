// Critical system constants extracted to break circular dependencies

import { getAPIProvider } from "../utils/model/providers.js"

const DEFAULT_PREFIX = `You are Wren, a local coding agent.`
const AGENT_SDK_PREFIX = `You are a Wren agent, running as a subagent.`

const CLI_SYSPROMPT_PREFIX_VALUES = [DEFAULT_PREFIX, AGENT_SDK_PREFIX] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(CLI_SYSPROMPT_PREFIX_VALUES)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  if (options?.isNonInteractive) {
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

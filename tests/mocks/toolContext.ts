/**
 * Minimal ToolUseContext factory for unit tests that exercise tool
 * `checkPermissions`/`call` paths without booting an engine. Only the
 * fields the tools under test read are populated; everything else is empty
 * or inert.
 */
import type { ToolUseContext } from "../../packages/engine/src/Tool.js"

type PermissionOverrides = {
  alwaysAllowRules?: Record<string, string[]>
  alwaysDenyRules?: Record<string, string[]>
}

export function mockToolContext(overrides?: {
  permissionOverrides?: PermissionOverrides
  messages?: ReadonlyArray<{ uuid?: string; type?: string }>
  toolUseId?: string
  abortController?: AbortController
}): ToolUseContext {
  const permissionContext = {
    mode: "default" as const,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: overrides?.permissionOverrides?.alwaysAllowRules ?? {},
    alwaysDenyRules: overrides?.permissionOverrides?.alwaysDenyRules ?? {},
    alwaysAskRules: {},
    isFullModeAvailable: false,
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: "test-model",
      tools: {},
      verbose: false,
      thinkingConfig: { type: "adaptive" },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { agentDefinitions: [], agentDefinitionsOverrides: [] },
    },
    abortController: overrides?.abortController ?? new AbortController(),
    readFileState: new Map(),
    getAppState: () => ({ toolPermissionContext: permissionContext }) as never,
    setAppState: () => {},
    alwaysSetAppState: () => {},
    messages: overrides?.messages ?? [],
    toolUseId: overrides?.toolUseId,
  } as ToolUseContext
}

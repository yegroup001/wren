import type { Tool, ToolUseContext } from "../Tool.js"
import type { AssistantMessage } from "../types/message.js"
import type { PermissionResult } from "../utils/permissions/PermissionResult.js"

export type CanUseToolFn = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionResult,
) => Promise<PermissionResult>

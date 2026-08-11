import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.mjs"

import type { Tool, ToolUseContext } from "../../Tool.js"
import type { AssistantMessage } from "../../types/message.js"
import type { PermissionResult } from "../../utils/permissions/PermissionResult.js"
import type { PermissionUpdate } from "../../utils/permissions/PermissionUpdateSchema.js"

export type ToolUseConfirm = {
  assistantMessage: AssistantMessage
  tool: Tool
  description: string
  input: Record<string, unknown>
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionResult
  permissionPromptStartTimeMs: number
  classifierCheckInProgress?: boolean
  onUserInteraction(): void
  onDismissCheckmark(): void
  onAbort(): void
  onAllow(
    updatedInput: Record<string, unknown>,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
  ): Promise<void>
  onReject(feedback?: string, contentBlocks?: ContentBlockParam[]): void
  recheckPermission(): Promise<void>
  /** Optional worker badge for in-process teammate permission prompts */
  workerBadge?: { name: string; color?: string }
}

// Centralized logging for tool permission decisions. All permission
// approve/reject events flow through logPermissionDecision(), which persists
// the decision on the tool use context for downstream inspection.
import type { Tool as ToolType, ToolUseContext } from "../../Tool.js"
import type { PermissionApprovalSource, PermissionRejectionSource } from "./PermissionContext.js"

type PermissionLogContext = {
  tool: ToolType
  input: unknown
  toolUseContext: ToolUseContext
  messageId: string
  toolUseID: string
}

// Discriminated union: 'accept' pairs with approval sources, 'reject' with rejection sources
type PermissionDecisionArgs =
  | { decision: "accept"; source: PermissionApprovalSource | "config" }
  | { decision: "reject"; source: PermissionRejectionSource | "config" }

// Flattens structured source into a string label
function sourceToString(source: PermissionApprovalSource | PermissionRejectionSource): string {
  switch (source.type) {
    case "hook":
      return "hook"
    case "user":
      return source.permanent ? "user_permanent" : "user_temporary"
    case "user_abort":
      return "user_abort"
    case "user_reject":
      return "user_reject"
    default:
      return "unknown"
  }
}

// Single entry point for all permission decision logging. Called by permission
// handlers after every approve/reject.
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  _permissionPromptStartTimeMs?: number,
): void {
  const { toolUseContext, toolUseID } = ctx
  const { decision, source } = args

  const sourceString = source === "config" ? "config" : sourceToString(source)

  // Persist decision on the context so downstream code can inspect what happened
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    source: sourceString,
    decision,
    timestamp: Date.now(),
  })
}

export type { PermissionDecisionArgs, PermissionLogContext }
export { logPermissionDecision }

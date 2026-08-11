export const MESSAGE_ROLES = ["user", "assistant", "system"] as const
export const SESSION_STATUS_TYPES = ["idle", "working", "compacting", "retry"] as const
export const TOOL_STATUS_TYPES = ["pending", "running", "completed", "failed"] as const
export const TODO_STATUS_TYPES = ["pending", "in_progress", "completed", "cancelled"] as const
export const PART_TYPES = ["text", "thinking", "tool_use", "tool_result"] as const
export const PERMISSION_DISPLAY_TYPES = [
  "edit",
  "bash",
  "read",
  "write",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "task",
  "default",
  "mcp",
  "network",
  "browser",
  "computer",
] as const
export const PERMISSION_RISK_TYPES = ["file", "bash", "network", "browser", "computer"] as const

export type MessageRole = (typeof MESSAGE_ROLES)[number]
export type SessionStatusType = (typeof SESSION_STATUS_TYPES)[number]
export type ToolStatusType = (typeof TOOL_STATUS_TYPES)[number]
export type TodoStatusType = (typeof TODO_STATUS_TYPES)[number]
export type PartType = (typeof PART_TYPES)[number]
export type PermissionDisplayType = (typeof PERMISSION_DISPLAY_TYPES)[number]
export type PermissionRiskType = (typeof PERMISSION_RISK_TYPES)[number]

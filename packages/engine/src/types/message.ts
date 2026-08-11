// Re-export core message types from @wren/model-provider
// This file adds UI-specific types on top of the base types.
export type {
  AssistantMessage,
  AttachmentMessage,
  CollapsibleMessage,
  CompactMetadata,
  ContentItem,
  GroupedToolUseMessage,
  HookResultMessage,
  Message,
  MessageContent,
  MessageOrigin,
  MessageType,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  PartialCompactDirection,
  ProgressMessage,
  RequestStartEvent,
  StopHookInfo,
  StreamEvent,
  SystemAgentsKilledMessage,
  SystemAPIErrorMessage,
  SystemApiMetricsMessage,
  SystemAwaySummaryMessage,
  SystemBridgeStatusMessage,
  SystemCompactBoundaryMessage,
  SystemFileSnapshotMessage,
  SystemInformationalMessage,
  SystemLocalCommandMessage,
  SystemMemorySavedMessage,
  SystemMessage,
  SystemMessageLevel,
  SystemMicrocompactBoundaryMessage,
  SystemPermissionRetryMessage,
  SystemScheduledTaskFireMessage,
  SystemStopHookSummaryMessage,
  SystemThinkingMessage,
  SystemTurnDurationMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  TypedMessageContent,
  UserMessage,
} from "@wren/model-provider"

import type { UUID } from "node:crypto"
// UI-specific types that depend on main-project internals
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from "src/tools/shared/gitOperationTracking.js"
import type {
  AssistantMessage,
  CollapsibleMessage,
  StopHookInfo,
  UserMessage,
} from "@wren/model-provider"

export type RenderableMessage =
  | AssistantMessage
  | UserMessage
  | (import("@wren/model-provider").Message & { type: "system" })
  | (import("@wren/model-provider").Message & {
      type: "attachment"
      attachment: {
        type: string
        memories?: { path: string; content: string; mtimeMs: number }[]
        [key: string]: unknown
      }
    })
  | (import("@wren/model-provider").Message & { type: "progress" })
  | import("@wren/model-provider").GroupedToolUseMessage
  | CollapsedReadSearchGroup

export type CollapsedReadSearchGroup = {
  type: "collapsed_read_search"
  uuid: UUID
  timestamp?: unknown
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  [key: string]: unknown
}

import type { SessionId } from "@wren/protocol"

export type Route =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionId: SessionId }
  | { readonly type: "session-list" }

export const HIDDEN_UNSUPPORTED_SURFACES = [
  "cloud account",
  "organization console",
  "upgrade prompts",
  "workspace marketplace",
  "plugin marketplace",
  "background subagents",
] as const

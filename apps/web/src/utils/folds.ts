import type { Part } from "@wren/protocol"

/**
 * Standard header the compaction summary message starts with. App-level
 * compactions inject the summary as a plain user message without the
 * <compact-summary> marker; detect it so those render as a collapsible fold
 * too (both live and after resume, where the marker-less text is persisted).
 */
export const COMPACTION_SUMMARY_HEADER =
  "This session is being continued from a previous conversation that ran out of context."

export function isCompactionSummaryText(text: string): boolean {
  return text.startsWith(COMPACTION_SUMMARY_HEADER)
}

export function parseCompactSummaryText(
  text: string,
): { notification: string; summary: string } | null {
  const m = text.match(/^([\s\S]*?)<compact-summary>([\s\S]*?)<\/compact-summary>/)
  if (m) return { notification: (m[1] ?? "").trim(), summary: (m[2] ?? "").trim() }
  if (isCompactionSummaryText(text)) return { notification: "", summary: text.trim() }
  return null
}

/** Last text part of a message, used for streaming cursor placement. */
export function lastTextPart(parts: readonly Part[]): Part | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type === "text" || part?.type === "thinking") return part
  }
  return undefined
}

export function messageText(parts: readonly Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

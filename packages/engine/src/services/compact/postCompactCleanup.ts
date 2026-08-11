import { clearSpeculativeChecks } from "src/tools/BashTool/bashPermissions.js"
import type { QuerySource } from "../../constants/querySource.js"
import { clearSystemPromptSections } from "../../constants/systemPromptSections.js"
import { getUserContext } from "../../context.js"
import { clearClassifierApprovals } from "../../utils/classifierApprovals.js"
import { resetGetMemoryFilesCache } from "../../utils/wrenmd.js"
import { logError } from "../../utils/log.js"
import { clearSessionMessagesCache } from "../../utils/sessionStorage.js"
import { resetMicrocompactState } from "./microCompact.js"

/**
 * Compact-scoped cleanup callbacks registered by REPL or other long-lived
 * components. Called during runPostCompactCleanup() so instance-scoped state
 * (e.g. contentReplacementState) is freed alongside module-level caches.
 */
const compactCleanupCallbacks: Array<() => void> = []

export function registerCompactCleanup(callback: () => void): void {
  compactCleanupCallbacks.push(callback)
}

/**
 * Run cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual /compact to free memory
 * held by tracking structures that are invalidated by compaction.
 *
 * Note: We intentionally do NOT clear invoked skill content here.
 * Skill content must survive across multiple compactions so that
 * createSkillAttachmentIfNeeded() can include the full skill text
 * in subsequent compaction attachments.
 *
 * querySource: pass the compacting query's source so we can skip
 * resets that would clobber main-thread module-level state. Subagents
 * (agent:*) run in the same process and share module-level state
 * (context-collapse store, getMemoryFiles one-shot hook flag,
 * getUserContext cache); resetting those when a SUBAGENT compacts
 * would corrupt the MAIN thread's state. All compaction callers should
 * pass querySource — undefined is only safe for callers that are
 * genuinely main-thread-only (/compact, /clear).
 */
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // Subagents (agent:*) run in the same process and share module-level
  // state with the main thread. Only reset main-thread module-level state
  // (context-collapse, memory file cache) for main-thread compacts.
  // Same startsWith pattern as isMainThread (index.ts:188).
  const isMainThreadCompact =
    querySource === undefined || querySource.startsWith("repl_main_thread") || querySource === "sdk"

  resetMicrocompactState()
  if (isMainThreadCompact) {
    // getUserContext is a memoized outer layer wrapping getWrenMds() →
    // getMemoryFiles(). If only the inner getMemoryFiles cache is cleared,
    // the next turn hits the getUserContext cache and never reaches
    // getMemoryFiles(), so the armed InstructionsLoaded hook never fires.
    // Manual /compact already clears this explicitly at its call sites;
    // auto-compact and reactive-compact did not — this centralizes the
    // clear so all compaction paths behave consistently.
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache("compact")
  }
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  clearSessionMessagesCache()
  for (const cb of compactCleanupCallbacks) {
    try {
      cb()
    } catch (error) {
      logError(error)
    }
  }
}

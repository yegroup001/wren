/**
 * Lazy registration of the framework's bundled skills.
 *
 * Module-level `registerBundledSkill()` calls hit a TDZ cycle
 * (bundledSkills.js transitively imports commands.ts, which imports this
 * module back). Registering from `getSkills()` instead guarantees the
 * registry module is fully initialized first.
 */

import { registerBundledSkill } from "../bundledSkills.js"
import { datavizSkill } from "./dataviz.js"
import { systemsPaperWritingSkill } from "./systemsPaperWriting.js"

let initialized = false

/** Register all bundled skills. Idempotent; safe to call on every getSkills(). */
export function ensureBundledSkillsRegistered(): void {
  if (initialized) return
  registerBundledSkill(datavizSkill)
  registerBundledSkill(systemsPaperWritingSkill)
  initialized = true
}

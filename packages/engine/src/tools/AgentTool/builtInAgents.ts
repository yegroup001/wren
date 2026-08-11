import { getIsNonInteractiveSession } from "src/bootstrap/state.js"
import { isEnvTruthy } from "src/utils/envUtils.js"
import { getCoordinatorAgents } from "../../coordinator/workerAgent.js"
import { EXPLORE_AGENT } from "./built-in/exploreAgent.js"
import { GENERAL_PURPOSE_AGENT } from "./built-in/generalPurposeAgent.js"
import { PLAN_AGENT } from "./built-in/planAgent.js"
import { VERIFICATION_AGENT } from "./built-in/verificationAgent.js"
import type { AgentDefinition } from "./loadAgentsDir.js"

export function areExplorePlanAgentsEnabled(): boolean {
  return true
}

export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
  if (
    isEnvTruthy(process.env.WREN_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  if (isEnvTruthy(process.env.WREN_COORDINATOR_MODE)) {
    return getCoordinatorAgents()
  }

  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, PLAN_AGENT, VERIFICATION_AGENT]
}

// Per-task model resolution for internal side-query API calls.
//
// config.taskModels maps a task key (memory, classifier, compact, title,
// websearch, permission-explainer, attachment-summary, hook) to an explicit
// { source, model, effort? } reference. Unspecified tasks use defaultModel.

import { TASK_MODEL_KEYS, TaskModelKeySchema } from "@wren/protocol"
import type { SelectedModelReference, TaskModelKey } from "@wren/protocol"
import { formatModelReference, getConfig } from "./configBridge.js"
import { getSmallFastModel, type ModelName } from "./model.js"

export { TASK_MODEL_KEYS, TaskModelKeySchema }
export type { TaskModelKey }

export function getTaskModel(taskKey: TaskModelKey): ModelName {
  const ref = getConfig().taskModels?.[taskKey]
  if (ref !== undefined) {
    return formatModelReference(ref)
  }
  return getSmallFastModel()
}

export function getTaskEffort(taskKey: TaskModelKey): string | undefined {
  return getConfig().taskModels?.[taskKey]?.effort
}

import type { LocalCommandCall } from "../../types/command.js"
import { getAllHooks, getHookDisplayText } from "../../utils/hooks/hooksSettings.js"

export const call: LocalCommandCall = async (_args, context) => {
  const hooks = getAllHooks(context.getAppState())
  if (hooks.length === 0) {
    return { type: "text", value: "No hooks configured." }
  }
  const lines = hooks.map(
    (hook) => `- [${hook.event}] ${getHookDisplayText(hook.config)} (${hook.source})`,
  )
  return { type: "text", value: `Configured hooks:\n${lines.join("\n")}` }
}

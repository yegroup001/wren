import { getIsNonInteractiveSession } from "../../bootstrap/state.js"
import type { Command } from "../../commands.js"

export const contextNonInteractive: Command = {
  type: "local",
  name: "context",
  supportsNonInteractive: true,
  description: "Show current context usage",
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: () => import("./context-noninteractive.js"),
}

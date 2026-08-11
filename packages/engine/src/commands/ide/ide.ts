import type { LocalCommandCall } from "../../types/command.js"
import { getTerminalIdeType } from "../../utils/ide.js"

export const call: LocalCommandCall = async () => {
  const ide = getTerminalIdeType()
  if (!ide) {
    return {
      type: "text",
      value: "No supported IDE detected. Wren works standalone — IDE integration is optional.",
    }
  }
  return { type: "text", value: `Detected IDE: ${ide}` }
}

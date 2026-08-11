import type { LocalCommandCall } from "../../types/command.js"
import { getCurrentMode } from "../../modes/store.js"
import { getWrenConfigSafe } from "../../utils/model/configBridge.js"
import { getTerminalIdeType } from "../../utils/ide.js"
import { getWrenConfigHomeDir } from "../../utils/envUtils.js"
import { VERSION } from "../../utils/buildInfo.js"

export const call: LocalCommandCall = async () => {
  const lines: string[] = []

  const config = getWrenConfigSafe()
  const defaultModel = config?.defaultModel
  lines.push(`Version: ${VERSION}`)
  lines.push(`Mode: ${getCurrentMode()?.slug ?? "default"}`)
  lines.push(
    defaultModel
      ? `Model: ${defaultModel.source}/${defaultModel.model}`
      : "Model: unset (see /models or ~/.wren/config.json)",
  )
  const ide = getTerminalIdeType()
  lines.push(`IDE: ${ide ?? "none detected"}`)
  lines.push(`Config: ${getWrenConfigHomeDir()}/config.json`)
  lines.push(`Data: ${getWrenConfigHomeDir()}`)

  return { type: "text", value: lines.join("\n") }
}

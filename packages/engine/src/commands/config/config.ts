import { existsSync } from "node:fs"
import { join } from "node:path"
import type { LocalCommandCall } from "../../types/command.js"
import { getWrenConfigHomeDir } from "../../utils/envUtils.js"
import { getWrenConfigSafe } from "../../utils/model/configBridge.js"

export const call: LocalCommandCall = async () => {
  const homeConfig = join(getWrenConfigHomeDir(), "config.json")
  const workspaceConfig = join(process.cwd(), ".wren", "config.json")

  const lines = [
    `User config: ${homeConfig}${existsSync(homeConfig) ? "" : " (not found)"}`,
    `Workspace config: ${workspaceConfig}${existsSync(workspaceConfig) ? "" : " (not found)"}`,
  ]

  const config = getWrenConfigSafe()
  if (config) {
    const themes = config.theme ? `theme=${config.theme}` : ""
    const autoCompact = config.autoCompact ? "auto-compact=on" : ""
    const language = config.preferredLanguage ? `lang=${config.preferredLanguage}` : ""
    const extras = [themes, autoCompact, language].filter(Boolean).join(", ")
    if (extras) lines.push(`Effective: ${extras}`)
  }

  lines.push("See .wren-config.example.json for the full format.")
  return { type: "text", value: lines.join("\n") }
}

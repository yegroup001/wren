import type { LocalCommandCall } from "../../types/command.js"
import { loadInstalledPluginsFromDisk } from "../../utils/plugins/installedPluginsManager.js"

export const call: LocalCommandCall = async (args) => {
  const subcommand = args.trim().toLowerCase()

  if (subcommand && subcommand !== "list") {
    return {
      type: "text",
      value: "Usage: /plugin [list] — list installed plugins. Install with /plugin install <name>@<marketplace>.",
    }
  }

  const installed = loadInstalledPluginsFromDisk()
  const ids = Object.keys(installed.plugins ?? {})
  if (ids.length === 0) {
    return {
      type: "text",
      value: "No plugins installed. Install one with /plugin install <plugin>@<marketplace>.",
    }
  }

  const lines = ids.map((id) => {
    const entries = installed.plugins?.[id] ?? []
    const scope = entries.map((e) => e.scope).join(",")
    const version = entries[0]?.version ?? ""
    return `- ${id}${version ? `@${version}` : ""} (${scope})`
  })
  return { type: "text", value: `Installed plugins:\n${lines.join("\n")}` }
}

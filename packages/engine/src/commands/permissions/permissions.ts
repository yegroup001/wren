import type { LocalCommandCall } from "../../types/command.js"
import { getCurrentMode } from "../../modes/store.js"
import { getSettingsFilePathForSource } from "../../utils/settings/settings.js"

export const call: LocalCommandCall = async () => {
  const mode = getCurrentMode()
  const lines = [
    `Permission mode: ${mode?.permissions?.defaultMode ?? "default"} (mode: ${mode?.slug ?? "default"})`,
  ]
  for (const source of ["userSettings", "projectSettings"] as const) {
    const path = getSettingsFilePathForSource(source)
    if (path) lines.push(`${source} settings: ${path}`)
  }
  lines.push("Allow/deny rules live in settings.json under permissions.allow/deny.")
  return { type: "text", value: lines.join("\n") }
}

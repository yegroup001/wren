import type { LocalCommandCall } from "../../types/command.js"
import { getCurrentMode, setCurrentMode } from "../../modes/store.js"

export const call: LocalCommandCall = async (args) => {
  const subcommand = args.trim()
  const current = getCurrentMode()?.slug ?? "default"

  if (subcommand === "open") {
    return {
      type: "text",
      value: "Plan mode has no local editor view in Wren. The plan is shown in the session.",
    }
  }

  if (subcommand !== "" && subcommand !== "on" && subcommand !== "off") {
    return { type: "text", value: `Usage: /plan [on|off|<description>]` }
  }

  const turnOn = subcommand === "" ? current !== "plan" : subcommand === "on"
  if (turnOn === (current === "plan")) {
    return { type: "text", value: `Plan mode is already ${current === "plan" ? "on" : "off"}` }
  }
  setCurrentMode(turnOn ? "plan" : "default")
  return { type: "text", value: `Plan mode ${turnOn ? "enabled" : "disabled"}` }
}

import type { Command } from "../../commands.js"

const plan = {
  type: "local",
  name: "plan",
  description: "Enable plan mode or view the current session plan",
  supportsNonInteractive: true,
  argumentHint: "[on|off]",
  load: () => import("./plan.js"),
} satisfies Command

export default plan

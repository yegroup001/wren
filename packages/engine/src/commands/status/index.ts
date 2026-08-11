import type { Command } from "../../commands.js"

const status = {
  type: "local",
  name: "status",
  description: "Show Wren status including version, model, mode, IDE, and config",
  supportsNonInteractive: true,
  load: () => import("./status.js"),
} satisfies Command

export default status

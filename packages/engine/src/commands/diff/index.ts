import type { Command } from "../../commands.js"

export default {
  type: "local",
  name: "diff",
  description: "Show uncommitted changes summary",
  supportsNonInteractive: true,
  load: () => import("./diff.js"),
} satisfies Command

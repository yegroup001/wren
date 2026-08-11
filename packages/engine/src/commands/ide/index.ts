import type { Command } from "../../commands.js"

const ide = {
  type: "local",
  name: "ide",
  description: "Show IDE integration status",
  supportsNonInteractive: true,
  load: () => import("./ide.js"),
} satisfies Command

export default ide

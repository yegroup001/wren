import type { Command } from "../../commands.js"

const plugin = {
  type: "local",
  name: "plugin",
  description: "List installed plugins",
  supportsNonInteractive: true,
  argumentHint: "[list]",
  load: () => import("./plugin.js"),
} satisfies Command

export default plugin

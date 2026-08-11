import type { Command } from "../../commands.js"

const rename = {
  type: "local",
  name: "rename",
  description: "Rename the current conversation",
  supportsNonInteractive: true,
  argumentHint: "[name]",
  load: () => import("./rename.js"),
} satisfies Command

export default rename

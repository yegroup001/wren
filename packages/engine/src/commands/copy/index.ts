import type { Command } from "../../commands.js"

const copy = {
  type: "local",
  name: "copy",
  description: "Print the last assistant response",
  supportsNonInteractive: true,
  load: () => import("./copy.js"),
} satisfies Command

export default copy

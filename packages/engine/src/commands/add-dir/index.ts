import type { Command } from "../../commands.js"

const addDir = {
  type: "local",
  name: "add-dir",
  description: "Check whether a directory is part of the working set",
  supportsNonInteractive: true,
  argumentHint: "<path>",
  load: () => import("./add-dir.js"),
} satisfies Command

export default addDir

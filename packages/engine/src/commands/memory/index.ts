import type { Command } from "../../commands.js"

const memory: Command = {
  type: "local",
  name: "memory",
  description: "Show memory directory and files",
  supportsNonInteractive: true,
  load: () => import("./memory.js"),
}

export default memory

import type { Command } from "../../commands.js"

const hooks = {
  type: "local",
  name: "hooks",
  description: "List configured hooks for tool events",
  supportsNonInteractive: true,
  load: () => import("./hooks.js"),
} satisfies Command

export default hooks

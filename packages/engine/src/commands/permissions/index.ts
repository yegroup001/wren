import type { Command } from "../../commands.js"

const permissions = {
  type: "local",
  name: "permissions",
  aliases: ["allowed-tools"],
  description: "Show permission mode and allow/deny rule locations",
  supportsNonInteractive: true,
  load: () => import("./permissions.js"),
} satisfies Command

export default permissions

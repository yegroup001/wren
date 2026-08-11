import type { Command } from "../../commands.js"

const config = {
  aliases: ["settings"],
  type: "local",
  name: "config",
  description: "Show config file paths and effective settings",
  supportsNonInteractive: true,
  load: () => import("./config.js"),
} satisfies Command

export default config

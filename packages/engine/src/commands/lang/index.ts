import type { Command } from "../../commands.js"

const lang = {
  type: "local",
  name: "lang",
  description: "Set display language (en/zh/auto)",
  supportsNonInteractive: true,
  argumentHint: "<en|zh|auto>",
  load: () => import("./lang.js"),
} satisfies Command

export default lang

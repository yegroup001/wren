import type { Command } from "../../commands.js"

const mcp = {
  type: "local",
  name: "mcp",
  description: "List configured MCP servers",
  supportsNonInteractive: true,
  argumentHint: "[list]",
  load: () => import("./mcp.js"),
} satisfies Command

export default mcp

import type { LocalCommandCall } from "../../types/command.js"
import { getAllMcpConfigs } from "../../services/mcp/config.js"

export const call: LocalCommandCall = async (args) => {
  const arg = args.trim()

  if (arg && arg !== "list") {
    return {
      type: "text",
      value: "Usage: /mcp [list] — manage MCP servers. Edit them in ~/.wren/config.json under mcpServers.",
    }
  }

  const { servers, errors } = await getAllMcpConfigs()
  const names = Object.keys(servers)
  if (names.length === 0) {
    const errorNote = errors.length > 0 ? `\nWarnings: ${errors.length} config(s) failed to load` : ""
    return {
      type: "text",
      value: `No MCP servers configured${errorNote}\nAdd one in ~/.wren/config.json under mcpServers.`,
    }
  }

  const lines = names.map((name) => {
    const server = servers[name]
    const type = "command" in server ? "stdio" : "url" in server ? "url" : server.type
    return `- ${name} (${type}, ${server.scope})`
  })
  const errorNote = errors.length > 0 ? `\nWarnings: ${errors.length} config(s) failed to load` : ""
  return { type: "text", value: `MCP servers:\n${lines.join("\n")}${errorNote}` }
}

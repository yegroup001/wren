// MCP string utility functions — pure, no dependencies
// Extracted from src/services/mcp/mcpStringUtils.ts and normalization.ts

const CLAUDEAI_SERVER_PREFIX = "claude.ai "
const MAX_MCP_NAME_LENGTH = 64
const MCP_TOOL_PREFIX_LENGTH = "mcp____".length

export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "")
  }
  return normalized.slice(0, MAX_MCP_NAME_LENGTH)
}

export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  const serverMaxLength = MAX_MCP_NAME_LENGTH - MCP_TOOL_PREFIX_LENGTH - 1
  const normalizedServerName = normalizeNameForMCP(serverName).slice(0, serverMaxLength)
  const prefix = `mcp__${normalizedServerName}__`
  const normalizedToolName = normalizeNameForMCP(toolName)
  return `${prefix}${normalizedToolName.slice(0, MAX_MCP_NAME_LENGTH - prefix.length)}`
}

export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  const parts = toolString.split("__")
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== "mcp" || !serverName) return null
  const toolName = toolNameParts.length > 0 ? toolNameParts.join("__") : undefined
  return { serverName, toolName }
}

export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  return tool.mcpInfo ? buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName) : tool.name
}

export function getMcpDisplayName(fullName: string, serverName: string): string {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return fullName.replace(prefix, "")
}

export function extractMcpToolDisplayName(userFacingName: string): string {
  let withoutSuffix = userFacingName.replace(/\s*\(MCP\)\s*$/, "")
  withoutSuffix = withoutSuffix.trim()
  const dashIndex = withoutSuffix.indexOf(" - ")
  if (dashIndex !== -1) return withoutSuffix.substring(dashIndex + 3).trim()
  return withoutSuffix
}

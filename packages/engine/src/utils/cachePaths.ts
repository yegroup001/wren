import { join } from "path"
import { getWrenConfigHome } from "@wren/config-node"
import { getFsImplementation } from "./fsOperations.js"
import { djb2Hash } from "./hash.js"

const CACHE_DIR = join(getWrenConfigHome(), "cache")

const MAX_SANITIZED_LENGTH = 200
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getProjectDir(cwd: string): string {
  return sanitizePath(cwd)
}

export const CACHE_PATHS = {
  baseLogs: () => join(CACHE_DIR, getProjectDir(getFsImplementation().cwd())),
  errors: () => join(CACHE_DIR, getProjectDir(getFsImplementation().cwd()), "errors"),
  messages: () => join(CACHE_DIR, getProjectDir(getFsImplementation().cwd()), "messages"),
  mcpLogs: (serverName: string) =>
    join(
      CACHE_DIR,
      getProjectDir(getFsImplementation().cwd()),
      `mcp-logs-${sanitizePath(serverName)}`,
    ),
}

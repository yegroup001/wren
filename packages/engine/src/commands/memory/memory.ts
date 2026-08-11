import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { LocalCommandCall } from "../../types/command.js"
import { getAutoMemPath, getMemoryBaseDir, isAutoMemoryEnabled } from "../../memdir/paths.js"

export const call: LocalCommandCall = async () => {
  if (!isAutoMemoryEnabled()) {
    return { type: "text", value: "Auto memory is disabled (WREN_DISABLE_AUTO_MEMORY)." }
  }
  const base = getMemoryBaseDir()
  const autoMem = getAutoMemPath()
  const lines = [`Memory directory: ${base}`]
  try {
    const entries = readdirSync(join(base, "memory"))
    lines.push(`Memory files (${entries.length}):`)
    for (const entry of entries.slice(0, 20)) lines.push(`- ${entry}`)
    if (entries.length > 20) lines.push(`... and ${entries.length - 20} more`)
  } catch {
    lines.push("Memory directory is empty or not created yet.")
  }
  lines.push(`Auto memory entrypoint: ${autoMem}`)
  return { type: "text", value: lines.join("\n") }
}

import { BASH_TOOL_NAME } from "src/tools/BashTool/toolName.js"
import { POWERSHELL_TOOL_NAME } from "src/tools/PowerShellTool/toolName.js"
import { isEnvTruthy } from "../envUtils.js"
import { getPlatform } from "../platform.js"

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * Runtime gate for PowerShellTool. Windows-only (the permission engine uses
 * Win32-specific path normalizations). Opt-in via env=1.
 *
 * Used by tools.ts (tool-list visibility), processBashCommand (! routing),
 * and promptShellExecution (skill frontmatter routing) so the gate is
 * consistent across all paths that invoke PowerShellTool.call().
 */
export function isPowerShellToolEnabled(): boolean {
  if (getPlatform() !== "windows") return false
  return isEnvTruthy(process.env.WREN_USE_POWERSHELL_TOOL)
}

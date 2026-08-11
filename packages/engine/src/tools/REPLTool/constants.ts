import { AGENT_TOOL_NAME } from "../AgentTool/constants.js"
import { BASH_TOOL_NAME } from "../BashTool/toolName.js"
import { FILE_EDIT_TOOL_NAME } from "../FileEditTool/constants.js"
import { FILE_READ_TOOL_NAME } from "../FileReadTool/prompt.js"
import { FILE_WRITE_TOOL_NAME } from "../FileWriteTool/prompt.js"
import { GLOB_TOOL_NAME } from "../GlobTool/prompt.js"
import { GREP_TOOL_NAME } from "../GrepTool/prompt.js"
import { NOTEBOOK_EDIT_TOOL_NAME } from "../NotebookEditTool/constants.js"

export const REPL_TOOL_NAME = "REPL"

/**
 * Tools that are only accessible via REPL when REPL mode is enabled.
 * When REPL mode is on, these tools are hidden from Wren.s direct use,
 * forcing Wren to use REPL for batch operations.
 */
export const REPL_ONLY_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
])

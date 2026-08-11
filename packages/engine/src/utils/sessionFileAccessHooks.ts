/**
 * Session file access hooks.
 * Tracks access to session memory and transcript files via Read, Grep, Glob tools.
 * Also tracks memdir file access via Read, Grep, Glob, Edit, and Write tools.
 */

import { FILE_EDIT_TOOL_NAME } from "src/tools/FileEditTool/constants.js"
import { inputSchema as editInputSchema } from "src/tools/FileEditTool/types.js"
import { FileReadTool } from "src/tools/FileReadTool/FileReadTool.js"
import { FILE_READ_TOOL_NAME } from "src/tools/FileReadTool/prompt.js"
import { FileWriteTool } from "src/tools/FileWriteTool/FileWriteTool.js"
import { FILE_WRITE_TOOL_NAME } from "src/tools/FileWriteTool/prompt.js"
import { GlobTool } from "src/tools/GlobTool/GlobTool.js"
import { GLOB_TOOL_NAME } from "src/tools/GlobTool/prompt.js"
import { GrepTool } from "src/tools/GrepTool/GrepTool.js"
import { GREP_TOOL_NAME } from "src/tools/GrepTool/prompt.js"
import {
  detectSessionFileType,
  detectSessionPatternType,
  isAutoMemFile,
} from "./memoryFileDetection.js"

/**
 * Extract the file path from a tool input for memdir detection.
 * Covers Read (file_path), Edit (file_path), and Write (file_path).
 */
function getFilePathFromInput(toolName: string, toolInput: unknown): string | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const parsed = FileReadTool.inputSchema.safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    case FILE_EDIT_TOOL_NAME: {
      const parsed = editInputSchema().safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    case FILE_WRITE_TOOL_NAME: {
      const parsed = FileWriteTool.inputSchema.safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    default:
      return null
  }
}

/**
 * Extract file type from tool input.
 * Returns the detected session file type or null.
 */
function getSessionFileTypeFromInput(
  toolName: string,
  toolInput: unknown,
): "session_memory" | "session_transcript" | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const parsed = FileReadTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      return detectSessionFileType(parsed.data.file_path)
    }
    case GREP_TOOL_NAME: {
      const parsed = GrepTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      // Check path if provided
      if (parsed.data.path) {
        const pathType = detectSessionFileType(parsed.data.path)
        if (pathType) return pathType
      }
      // Check glob pattern
      if (parsed.data.glob) {
        const globType = detectSessionPatternType(parsed.data.glob)
        if (globType) return globType
      }
      return null
    }
    case GLOB_TOOL_NAME: {
      const parsed = GlobTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      // Check path if provided
      if (parsed.data.path) {
        const pathType = detectSessionFileType(parsed.data.path)
        if (pathType) return pathType
      }
      // Check pattern
      const patternType = detectSessionPatternType(parsed.data.pattern)
      if (patternType) return patternType
      return null
    }
    default:
      return null
  }
}

/**
 * Check if a tool use constitutes a memory file access.
 * Detects session memory (via Read/Grep/Glob) and memdir access (via Read/Edit/Write).
 */
export function isMemoryFileAccess(toolName: string, toolInput: unknown): boolean {
  if (getSessionFileTypeFromInput(toolName, toolInput) === "session_memory") {
    return true
  }

  const filePath = getFilePathFromInput(toolName, toolInput)
  if (filePath && isAutoMemFile(filePath)) {
    return true
  }

  return false
}

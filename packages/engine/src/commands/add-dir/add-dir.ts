import type { LocalCommandCall } from "../../types/command.js"
import { validateDirectoryForWorkspace, addDirHelpMessage } from "./validation.js"

export const call: LocalCommandCall = async (args, context) => {
  const directoryPath = args.trim()

  if (!directoryPath) {
    return {
      type: "text",
      value: "Usage: /add-dir <path> — checks whether a directory is part of the working set.",
    }
  }

  const result = await validateDirectoryForWorkspace(
    directoryPath,
    context.getAppState().toolPermissionContext,
  )
  if (result.resultType === "success") {
    return {
      type: "text",
      value: `${result.absolutePath} is valid. Working directories are the launch directory plus symlink variants; to grant access to this path, launch Wren from it (or add it via settings.json permissions rules).`,
    }
  }
  return { type: "text", value: addDirHelpMessage(result) }
}

// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = "Edit"

// Permission pattern for granting session-level access to the project's .wren/ folder
export const WREN_FOLDER_PERMISSION_PATTERN = "/.wren/**"

// Permission pattern for granting session-level access to the global ~/.wren/ folder
export const GLOBAL_WREN_FOLDER_PERMISSION_PATTERN = "~/.wren/**"

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  "File has been unexpectedly modified. Read it again before attempting to write it."

import type { FileEditInput } from "./types.js"

export function userFacingName(): string {
  return "Edit"
}

export function getToolUseSummary(input: Partial<FileEditInput> | undefined): string | null {
  const filePath = input?.file_path
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null
}

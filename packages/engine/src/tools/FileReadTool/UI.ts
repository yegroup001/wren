import type { Input } from "./FileReadTool.js"

export function userFacingName(): string {
  return "Read"
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  const filePath = input?.file_path
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null
}

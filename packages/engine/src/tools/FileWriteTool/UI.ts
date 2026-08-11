
export function userFacingName(): string {
  return "Write"
}

export function getToolUseSummary(input: { file_path?: string } | undefined): string | null {
  const filePath = input?.file_path
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null
}

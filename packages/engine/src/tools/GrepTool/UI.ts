
export function userFacingName(): string {
  return "Grep"
}

export function getToolUseSummary(
  input: { pattern?: string; path?: string; glob?: string; output_mode?: string } | undefined,
): string | null {
  const pattern = input?.pattern
  if (typeof pattern !== "string" || pattern.length === 0) return null
  const location = input?.path ?? input?.glob
  return location ? `${pattern} in ${location}` : pattern
}

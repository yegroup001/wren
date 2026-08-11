
export function userFacingName(): string {
  return "Glob"
}

export function getToolUseSummary(input: { pattern?: string; path?: string } | undefined): string | null {
  const pattern = input?.pattern
  if (typeof pattern !== "string" || pattern.length === 0) return null
  return input?.path ? `${pattern} in ${input.path}` : pattern
}

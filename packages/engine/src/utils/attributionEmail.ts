const MODEL_EMAIL_MAP: Array<{ keywords: string[]; email: string }> = [
  { keywords: ["claude"], email: "noreply@anthropic.com" },
]

export function getAttributionEmail(modelName: string): string {
  const lower = modelName.toLowerCase()
  for (const { keywords, email } of MODEL_EMAIL_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return email
    }
  }
  return "noreply@anthropic.com"
}

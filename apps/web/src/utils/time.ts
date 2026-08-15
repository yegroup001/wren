export function formatTime(iso: string | undefined): string {
  if (iso === undefined || iso === "") return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const now = Date.now()
  const diff = now - date.getTime()
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function formatClock(iso: string | undefined): string {
  if (iso === undefined || iso === "") return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

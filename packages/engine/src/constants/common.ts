import memoize from "lodash-es/memoize.js"

// This ensures you get the LOCAL date in ISO format
export function getLocalISODate(): string {
  // Check for legacy date override
  if (process.env.WREN_OVERRIDE_DATE) {
    return process.env.WREN_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// Memoized for prompt-cache stability — captures the date once at session start.
// When midnight rolls over, getDateChangeAttachments appends the new date at the tail.
export const getSessionStartDate = memoize(getLocalISODate)

// Returns "Month YYYY" (e.g. "February 2026") in the user's local timezone.
// Changes monthly, not daily — used in tool prompts to minimize cache busting.
export function getLocalMonthYear(): string {
  const date = process.env.WREN_OVERRIDE_DATE
    ? new Date(process.env.WREN_OVERRIDE_DATE)
    : new Date()
  return date.toLocaleString("en-US", { month: "long", year: "numeric" })
}

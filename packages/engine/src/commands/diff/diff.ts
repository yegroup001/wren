import type { LocalCommandCall } from "../../types/command.js"
import { fetchGitDiff } from "../../utils/gitDiff.js"

export const call: LocalCommandCall = async () => {
  const diff = await fetchGitDiff()
  if (diff === null) {
    return { type: "text", value: "Not a git repository or git is unavailable." }
  }
  if (diff.stats.filesCount === 0) {
    return { type: "text", value: "No uncommitted changes." }
  }
  const lines = [`${diff.stats.filesCount} file(s) changed: +${diff.stats.linesAdded} -${diff.stats.linesRemoved}`]
  for (const [file, stats] of diff.perFileStats) {
    const details = stats.isBinary ? " (binary)" : ` +${stats.added} -${stats.removed}`
    lines.push(`- ${file}${details}`)
  }
  return { type: "text", value: lines.join("\n") }
}

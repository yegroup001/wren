import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { getWrenConfigHome } from "@wren/config-node"
import { createSignal } from "solid-js"

export const MAX_HISTORY_ENTRIES = 50

export type PromptHistoryEntry = {
  readonly input: string
  readonly timestamp: string
}

export const DEFAULT_HISTORY_FILE = path.join(getWrenConfigHome(), "prompt-history.jsonl")

export function parseHistory(text: string): PromptHistoryEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptHistoryEntry
      } catch {
        return undefined
      }
    })
    .filter((entry): entry is PromptHistoryEntry => entry !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicate(
  prev: PromptHistoryEntry | undefined,
  next: PromptHistoryEntry,
): boolean {
  if (prev === undefined) return false
  return prev.input === next.input
}

export type PromptHistory = {
  readonly entries: () => readonly PromptHistoryEntry[]
  readonly move: (direction: "up" | "down", currentInput: string) => string | undefined
  readonly append: (input: string) => void
  readonly search: (query: string) => readonly PromptHistoryEntry[]
  readonly reset: () => void
}

export function createPromptHistory(filePath: string = DEFAULT_HISTORY_FILE): PromptHistory {
  const [entries, setEntries] = createSignal<PromptHistoryEntry[]>([])
  const [cursor, setCursor] = createSignal(-1)
  let draft = ""
  let loadPromise: Promise<void> | undefined

  async function load(): Promise<void> {
    if (loadPromise !== undefined) return loadPromise
    loadPromise = (async () => {
      try {
        await mkdir(path.dirname(filePath), { recursive: true })
        const text = await readFile(filePath, "utf-8").catch(() => "")
        setEntries(parseHistory(text))
      } catch {
        // Swallow: history is best-effort, not critical
      }
    })()
    return loadPromise
  }

  void load()

  function move(direction: "up" | "down", currentInput: string): string | undefined {
    const list = entries()
    if (list.length === 0) return undefined
    const cur = cursor()

    if (direction === "up") {
      if (cur === -1) {
        draft = currentInput
        setCursor(list.length - 1)
        return list[list.length - 1]?.input
      }
      if (cur > 0) {
        setCursor(cur - 1)
        return list[cur - 1]?.input
      }
      return undefined
    }

    // direction === "down"
    if (cur === -1) return undefined
    if (cur < list.length - 1) {
      setCursor(cur + 1)
      return list[cur + 1]?.input
    }
    setCursor(-1)
    return draft
  }

  // m11: atomic write via temp file + rename to prevent corruption from
  // concurrent Wren instances. rename is atomic on POSIX.
  async function persist(list: readonly PromptHistoryEntry[]): Promise<void> {
    const content = `${list.map((e) => JSON.stringify(e)).join("\n")}\n`
    const tmpPath = `${filePath}.tmp.${process.pid}`
    await writeFile(tmpPath, content, "utf-8")
    await rename(tmpPath, filePath)
  }

  async function append(input: string): Promise<void> {
    const trimmed = input.trim()
    if (trimmed.length === 0) return
    await load()
    const list = entries()
    if (isDuplicate(list.at(-1), { input: trimmed, timestamp: "" })) {
      setCursor(-1)
      return
    }
    const entry: PromptHistoryEntry = {
      input: trimmed,
      timestamp: new Date().toISOString(),
    }
    const next = [...list, entry]
    const trimmedList = next.length > MAX_HISTORY_ENTRIES ? next.slice(-MAX_HISTORY_ENTRIES) : next
    setEntries(trimmedList)
    setCursor(-1)

    void persist(trimmedList).catch(() => {})
  }

  function search(query: string): readonly PromptHistoryEntry[] {
    const needle = query.trim().toLowerCase()
    if (needle === "") return []
    return entries()
      .filter((e) => e.input.toLowerCase().includes(needle))
      .reverse()
      .slice(0, 20)
  }

  return { entries, move, append, search, reset: () => setCursor(-1) }
}

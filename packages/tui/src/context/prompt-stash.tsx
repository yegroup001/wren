import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { getWrenConfigHome } from "@wren/config-node"
import { createSignal, type JSX, type ParentProps } from "solid-js"
import { createSimpleContext } from "./helper"

const MAX_STASH_ENTRIES = 50
const STASH_FILE = path.join(getWrenConfigHome(), "prompt-stash.jsonl")

export type StashEntry = {
  readonly input: string
  readonly timestamp: string
  readonly label?: string
}

export type PromptStash = {
  readonly entries: () => readonly StashEntry[]
  readonly stash: (input: string, label?: string) => void
  readonly pop: () => StashEntry | undefined
  readonly remove: (index: number) => void
  readonly clear: () => void
}

export function parseStash(text: string): StashEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as StashEntry
      } catch {
        return undefined
      }
    })
    .filter((entry): entry is StashEntry => entry !== undefined)
    .slice(-MAX_STASH_ENTRIES)
}

const { use, provider } = createSimpleContext<PromptStash>({
  name: "PromptStash",
  init: () => {
    const [entries, setEntries] = createSignal<StashEntry[]>([])
    let loadPromise: Promise<void> | undefined

    async function load(): Promise<void> {
      if (loadPromise !== undefined) return loadPromise
      loadPromise = (async () => {
        try {
          await mkdir(path.dirname(STASH_FILE), { recursive: true })
          const text = await readFile(STASH_FILE, "utf-8").catch(() => "")
          setEntries(parseStash(text))
        } catch {
          // Swallow: stash is best-effort, not critical
        }
      })()
      return loadPromise
    }

    async function persist(list: readonly StashEntry[]): Promise<void> {
      const content = `${list.map((e) => JSON.stringify(e)).join("\n")}\n`
      const tmpPath = `${STASH_FILE}.tmp.${process.pid}`
      await writeFile(tmpPath, content, "utf-8")
      await rename(tmpPath, STASH_FILE)
    }

    function stash(input: string, label?: string): void {
      const trimmed = input.trim()
      if (trimmed.length === 0) return
      const entry: StashEntry = {
        input: trimmed,
        timestamp: new Date().toISOString(),
        ...(label !== undefined && label.trim().length > 0 ? { label: label.trim() } : {}),
      }
      const next = [...entries(), entry].slice(-MAX_STASH_ENTRIES)
      setEntries(next)
      void persist(next).catch(() => {})
    }

    function pop(): StashEntry | undefined {
      const list = entries()
      if (list.length === 0) return undefined
      // biome-ignore lint/style/noNonNullAssertion: checked length > 0
      const last = list[list.length - 1]!
      const next = list.slice(0, -1)
      setEntries(next)
      void persist(next).catch(() => {})
      return last
    }

    function remove(index: number): void {
      const list = entries()
      if (index < 0 || index >= list.length) return
      const next = [...list.slice(0, index), ...list.slice(index + 1)]
      setEntries(next)
      void persist(next).catch(() => {})
    }

    function clear(): void {
      setEntries([])
      void persist([]).catch(() => {})
    }

    void load()

    return { entries, stash, pop, remove, clear }
  },
})

export const usePromptStash = use

export function PromptStashProvider(props: ParentProps): JSX.Element {
  return provider(props)
}

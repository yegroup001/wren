import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setWrenConfigHomeForTests } from "@wren/config-node"
import { clearConfigHomeCache } from "../envUtils.js"

const MAX_CACHED_ENTRIES = 200 // mirrors MAX_CACHED_SESSION_FILES in sessionStorage.ts

const {
  getSessionMessages,
  getSessionMessagesCache,
  clearSessionMessagesCache,
  enqueueEntriesForTesting,
  resetProjectFlushStateForTesting,
  setAppendToFileForTesting,
} = await import("../sessionStorage.js")

function asUuid(s: string): any {
  return s as unknown as any
}

let tempDir: string

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  // `getProjectsDir()` returns `${configHome}/projects`, and
  // loadSessionFile reads from `${getProjectsDir()}/${sessionId}.jsonl`.
  // Pre-create the projects subdir so writeFileSync doesn't fail.
  mkdirSync(join(tempDir, "projects"), { recursive: true })
  // Pin session-file lookups to a temp dir via the test override.
  // Restoring in afterEach keeps tests hermetic.
  setWrenConfigHomeForTests(tempDir)
  clearConfigHomeCache()
})

afterEach(() => {
  clearSessionMessagesCache()
  setAppendToFileForTesting(undefined)
  resetProjectFlushStateForTesting()
  setWrenConfigHomeForTests(undefined)
  clearConfigHomeCache()
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function sessionFilePath(sessionId: string): string {
  // Mirror sessionStorage.ts's path computation:
  //   getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  // With configHome=tempDir and getSessionProjectDir() returning
  // null in tests, files live at `${tempDir}/projects/${sessionId}.jsonl`.
  return join(tempDir, "projects", `${sessionId}.jsonl`)
}

describe("getSessionMessagesCache", () => {
  test("returns the same Map instance across calls", () => {
    // Cache identity must be stable — `getLastSessionLog` uses
    // `getSessionMessagesCache()` directly to prime entries, so a
    // different instance each call would break that priming.
    expect(getSessionMessagesCache()).toBe(getSessionMessagesCache())
  })

  test("clearSessionMessagesCache empties a populated cache", async () => {
    const cache = getSessionMessagesCache()
    writeFileSync(sessionFilePath("id-1"), "")
    writeFileSync(sessionFilePath("id-2"), "")
    await getSessionMessages(asUuid("id-1"))
    await getSessionMessages(asUuid("id-2"))
    expect(cache.size).toBeGreaterThan(0)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test("clearSessionMessagesCache is a no-op on empty cache", () => {
    const cache = getSessionMessagesCache()
    expect(cache.size).toBe(0)
    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test("getSessionMessages dedups concurrent calls for the same sessionId", async () => {
    const cache = getSessionMessagesCache()
    const id = asUuid("same-id")
    writeFileSync(sessionFilePath("same-id"), "")
    const [a, b, c] = await Promise.all([
      getSessionMessages(id),
      getSessionMessages(id),
      getSessionMessages(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(cache.size).toBe(1)
  })
})

describe("getSessionMessages bounded cache (memory leak fix)", () => {
  test("cache size stays at MAX_CACHED_ENTRIES after many distinct sessionIds", async () => {
    // Bounded cache — calling getSessionMessages with N distinct
    // sessionIds must NOT grow the cache beyond MAX_CACHED_ENTRIES.
    // Pre-fix: lodash memoize grew unbounded. Post-fix: Map-based
    // cache evicts oldest entry when at capacity.
    const cache = getSessionMessagesCache()
    const total = MAX_CACHED_ENTRIES * 3 // 600 distinct sessionIds
    for (let i = 0; i < total; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), "")
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })

  test("FIFO eviction: oldest entry is removed first", async () => {
    // Fill cache to MAX with sequential ids. The first inserted
    // (`oldest`) should be evicted on the (MAX+1)th insertion.
    const cache = getSessionMessagesCache()
    const oldestId = asUuid("id-0")
    writeFileSync(sessionFilePath("id-0"), "")
    await getSessionMessages(oldestId)
    for (let i = 1; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), "")
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(true)

    writeFileSync(sessionFilePath("id-overflow"), "")
    await getSessionMessages(asUuid("id-overflow"))
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(false)
  })

  test("cleared cache can be refilled without leaking entries", async () => {
    const cache = getSessionMessagesCache()
    for (let i = 0; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), "")
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)

    for (let i = 0; i < MAX_CACHED_ENTRIES + 5; i++) {
      writeFileSync(sessionFilePath(`refill-${i}`), "")
      await getSessionMessages(asUuid(`refill-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })
})

const testEntry = (uuid: string) =>
  ({
    type: "user",
    uuid,
    message: { role: "user", content: uuid },
  }) as never

describe("serialized transcript drains", () => {
  test("does not overlap file appends when a drain is still pending", async () => {
    const writes: string[] = []
    let activeWrites = 0
    let maxActiveWrites = 0
    let releaseFirstWrite: (() => void) | undefined
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })

    resetProjectFlushStateForTesting()
    setAppendToFileForTesting(async (_filePath, data) => {
      activeWrites++
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      writes.push(data)
      if (writes.length === 1) {
        await firstWriteBlocked
      }
      activeWrites--
    })

    const first = enqueueEntriesForTesting("/tmp/session-storage-race.jsonl", [testEntry("one")])[0]
    await new Promise((resolve) => setTimeout(resolve, 125))
    const second = enqueueEntriesForTesting("/tmp/session-storage-race.jsonl", [
      testEntry("two"),
    ])[0]
    releaseFirstWrite?.()
    await Promise.all([first, second])
    setAppendToFileForTesting(undefined)

    expect(maxActiveWrites).toBe(1)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain('"uuid":"one"')
    expect(writes[1]).toContain('"uuid":"two"')
  })
})

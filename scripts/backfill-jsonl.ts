#!/usr/bin/env bun
import { readdir, readFile, rm, stat } from "node:fs/promises"
/**
 * One-time backfill: import legacy JSONL transcript files into engine_event
 * (sessions.db), then delete the JSONL files once verified.
 *
 * The engine_* tables are the storage of record; JSONL writes are disabled at
 * runtime (setTranscriptFileSink(noop)), but files written before the mirror
 * existed still live in ~/.wren/projects and are used as a resume fallback.
 * This script replays them through the same entry→event mapping the mirror
 * uses (mirrorEntryToSqlite in packages/engine/src/utils/sessionStorage.ts),
 * with the same hasMessage dedup so already-mirrored sessions stay intact.
 *
 * Usage (run with the wren app closed):
 *   bun run scripts/backfill-jsonl.ts [dbPath] [projectsDir] [--dry-run] [--keep-files]
 *
 * Defaults: <config-home>/sessions.db and <config-home>/projects
 * (~/.config/wren by default).
 * --dry-run only prints what would happen. Without --keep-files the JSONL
 * and .meta.json files are deleted after verification passes.
 */
import { basename, dirname, join, relative, sep } from "node:path"
import { getWrenConfigHome } from "@wren/config-node"
import { createEngineTranscriptStore, type EngineTranscriptStore } from "@wren/storage"

const MESSAGE_TYPES = new Set(["user", "assistant", "attachment", "system"])

type JsonlEntry = Record<string, unknown> & {
  type?: unknown
  uuid?: unknown
  sessionId?: unknown
  parentUuid?: unknown
  timestamp?: unknown
  subtype?: unknown
}

type Candidate = {
  path: string
  sessionId: string
  agentId?: string
}

function parseArgs(): { dbPath: string; projectsDir: string; dryRun: boolean; keepFiles: boolean } {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"))
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")))
  const configHome = process.env.WREN_CONFIG_HOME ?? getWrenConfigHome()
  return {
    dbPath: positional[0] ?? join(configHome, "sessions.db"),
    projectsDir: positional[1] ?? join(configHome, "projects"),
    dryRun: flags.has("--dry-run"),
    keepFiles: flags.has("--keep-files"),
  }
}

function isMessageEntry(entry: JsonlEntry): entry is JsonlEntry & { uuid: string } {
  return (
    typeof entry.type === "string" &&
    MESSAGE_TYPES.has(entry.type) &&
    typeof entry.uuid === "string"
  )
}

function isCompactEntry(entry: JsonlEntry): boolean {
  return entry.type === "system" && entry.subtype === "compact_boundary"
}

async function listJsonlFiles(projectsDir: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const projects = await readdir(projectsDir, { withFileTypes: true })

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(projectsDir, project.name)
    const entries = await readdir(projectPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        candidates.push({
          path: join(projectPath, entry.name),
          sessionId: basename(entry.name, ".jsonl"),
        })
      }
    }

    // Session-scoped subagent dirs: <project>/<sessionId>/subagents/agent-*.jsonl
    for (const sub of entries) {
      if (!sub.isDirectory()) continue
      const sessionDir = join(projectPath, sub.name)
      const sessionId = sub.name
      const subagentsDir = join(sessionDir, "subagents")
      try {
        await stat(subagentsDir)
      } catch {
        continue
      }
      const files = await readdir(subagentsDir, { withFileTypes: true })
      for (const file of files) {
        if (!file.isFile() || !file.name.startsWith("agent-") || !file.name.endsWith(".jsonl"))
          continue
        const agentId = file.name.slice("agent-".length, -".jsonl".length)
        candidates.push({ path: join(subagentsDir, file.name), sessionId, agentId })
      }
    }
  }
  return candidates
}

async function parseJsonlLines(filePath: string): Promise<JsonlEntry[]> {
  const content = await readFile(filePath, "utf-8")
  const entries: JsonlEntry[] = []
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === "object") entries.push(parsed as JsonlEntry)
    } catch {
      // skip unparseable lines rather than failing the whole file
    }
  }
  return entries
}

async function backfillFile(
  store: EngineTranscriptStore,
  candidate: Candidate,
  projectPathLabel: string,
  stats: {
    mirrored: number
    skipped: number
    alreadyPresent: number
    files: number
    failed: string[]
  },
): Promise<boolean> {
  const entries = await parseJsonlLines(candidate.path)
  stats.files++
  const failures: string[] = []
  let fileOk = true

  for (const entry of entries) {
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : candidate.sessionId
    const stream =
      candidate.agentId !== undefined
        ? { sessionId, agentId: candidate.agentId, isSidechain: true }
        : { sessionId }

    if (isMessageEntry(entry)) {
      if (await store.hasMessage(sessionId, entry.uuid)) {
        stats.alreadyPresent++
        continue
      }
    }

    try {
      await store.append(sessionId, projectPathLabel, stream, [
        {
          type: String(entry.type ?? "unknown"),
          payload: entry,
          ...(isMessageEntry(entry) && { messageUuid: entry.uuid }),
          ...(typeof entry.parentUuid === "string" && { parentUuid: entry.parentUuid }),
          ...(typeof entry.timestamp === "string" && { timestamp: entry.timestamp }),
          ...(isCompactEntry(entry) && { isCompact: true }),
        },
      ])
      stats.mirrored++
    } catch (error) {
      fileOk = false
      failures.push(
        `${relative(process.cwd(), candidate.path)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (failures.length > 0) stats.failed.push(...failures)
  return fileOk
}

async function verifyCoverage(
  store: EngineTranscriptStore,
  candidates: readonly Candidate[],
): Promise<{ total: number; missing: number }> {
  let total = 0
  let missing = 0
  for (const candidate of candidates) {
    const entries = await parseJsonlLines(candidate.path)
    for (const entry of entries) {
      if (!isMessageEntry(entry)) continue
      total++
      const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : candidate.sessionId
      if (!(await store.hasMessage(sessionId, entry.uuid))) missing++
    }
  }
  return { total, missing }
}

async function backfillAgentMeta(
  store: EngineTranscriptStore,
  projectsDir: string,
  stats: { metaFiles: number; metaMirrored: number },
): Promise<void> {
  const projects = await readdir(projectsDir, { withFileTypes: true })
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(projectsDir, project.name)
    const entries = await readdir(projectPath, { withFileTypes: true })
    for (const sub of entries) {
      if (!sub.isDirectory()) continue
      const subagentsDir = join(projectPath, sub.name, "subagents")
      let files: Awaited<ReturnType<typeof readdir>>
      try {
        files = await readdir(subagentsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.startsWith("agent-") || !file.name.endsWith(".meta.json"))
          continue
        stats.metaFiles++
        const agentId = file.name.slice("agent-".length, -".meta.json".length)
        try {
          const raw = await readFile(join(subagentsDir, file.name), "utf-8")
          const meta: unknown = JSON.parse(raw)
          if (meta === null || typeof meta !== "object") continue
          const record = meta as Record<string, unknown>
          if (typeof record.agentType !== "string") continue
          await store.saveAgentMeta(sub.name, {
            agentId,
            sessionId: sub.name,
            agentType: record.agentType,
            ...(typeof record.worktreePath === "string" && { worktreePath: record.worktreePath }),
            ...(typeof record.description === "string" && { description: record.description }),
          })
          stats.metaMirrored++
        } catch (error) {
          console.error(
            `meta ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const { dbPath, projectsDir, dryRun, keepFiles } = parseArgs()

  try {
    await stat(projectsDir)
  } catch {
    console.error(`projects dir not found: ${projectsDir}`)
    process.exit(1)
  }

  const store = createEngineTranscriptStore(dbPath)
  const candidates = await listJsonlFiles(projectsDir)
  console.log(`db: ${dbPath}`)
  console.log(`projects: ${projectsDir}`)
  console.log(`jsonl files: ${candidates.length}`)

  if (dryRun) {
    for (const candidate of candidates) {
      const entries = await parseJsonlLines(candidate.path)
      console.log(`  ${candidate.path}`)
      console.log(
        `    entries=${entries.length} session=${candidate.sessionId}${candidate.agentId !== undefined ? ` agent=${candidate.agentId}` : ""}`,
      )
    }
    const { total, missing } = await verifyCoverage(store, candidates)
    console.log(`coverage (message entries): total=${total} missing=${missing}`)
    store.close()
    return
  }

  const stats = { mirrored: 0, skipped: 0, alreadyPresent: 0, files: 0, failed: [] as string[] }
  let allOk = true
  for (const candidate of candidates) {
    const projectPathLabel = relative(projectsDir, dirname(candidate.path)).split(sep)[0] ?? ""
    const ok = await backfillFile(store, candidate, projectPathLabel, stats)
    if (!ok) allOk = false
  }
  const metaStats = { metaFiles: 0, metaMirrored: 0 }
  await backfillAgentMeta(store, projectsDir, metaStats)

  const { total, missing } = await verifyCoverage(store, candidates)

  console.log(`\nmirrored entries: ${stats.mirrored} (already present: ${stats.alreadyPresent})`)
  console.log(`agent meta: ${metaStats.metaMirrored}/${metaStats.metaFiles}`)
  console.log(`verification: ${total - missing}/${total} message entries covered`)
  if (stats.failed.length > 0) {
    console.error(`\n${stats.failed.length} append failure(s):`)
    for (const failure of stats.failed.slice(0, 10)) console.error(`  ${failure}`)
    allOk = false
  }

  store.close()

  if (!allOk || missing > 0) {
    console.error("backfill incomplete — JSONL files NOT deleted")
    process.exit(1)
  }

  if (keepFiles) {
    console.log("verification passed; files kept (--keep-files)")
    return
  }

  let deleted = 0
  for (const candidate of candidates) {
    await rm(candidate.path, { force: true })
    deleted++
  }
  // .meta.json sidecars
  const projects = await readdir(projectsDir, { withFileTypes: true })
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(projectsDir, project.name)
    const entries = await readdir(projectPath, { withFileTypes: true })
    for (const sub of entries) {
      if (!sub.isDirectory()) continue
      const subagentsDir = join(projectPath, sub.name, "subagents")
      let files: Awaited<ReturnType<typeof readdir>>
      try {
        files = await readdir(subagentsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(".meta.json")) {
          await rm(join(subagentsDir, file.name), { force: true })
          deleted++
        }
      }
    }
  }
  console.log(`deleted ${deleted} JSONL/meta files`)
}

await main()

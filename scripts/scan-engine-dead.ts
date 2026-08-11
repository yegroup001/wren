/**
 * Engine dead-code scanner: computes the transitive import closure from a
 * conservative set of live entry points over packages/engine/src, resolving
 * relative imports, "src/" alias, .js→.ts extension, and static dynamic
 * imports. Files outside the closure (excluding tests) are dead candidates.
 *
 * Usage: bun scripts/scan-engine-dead.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"

const ENGINE_SRC = resolve("packages/engine/src")

const EXTRA_ENTRY_POINTS = [
  "bridge/peerSessions",
  "components/CtrlOToExpand",
  "constants/files",
  "coordinator/workerAgent",
  "services/SessionMemory/multiStore",
  "services/localVault/store",
  "services/policyLimits/index",
  "services/skillSearch/remoteSkillLoader",
  "services/skillSearch/remoteSkillState",
  "services/teamMemorySync/teamMemSecretGuard",
  "services/voiceStreamSTT",
  "tasks/LocalMainSessionTask",
  "tasks/LocalShellTask/killShellTasks",
  "tasks/stopTask",
  "types/notebook",
  "utils/agentToolFilter",
  "utils/bash/ParsedCommand",
  "utils/bash/ast",
  "utils/bash/parser",
  "utils/bash/treeSitterAnalysis",
  "utils/cron",
  "utils/cronTasks",
  "utils/diff",
  "utils/gitDiff",
  "utils/glob",
  "utils/hooks/registerFrontmatterHooks",
  "utils/imagePaste",
  "utils/inProcessTeammateHelpers",
  "utils/localValidate",
  "utils/model/agent",
  "utils/model/validateModel",
  "utils/notebook",
  "utils/peerAddress",
  "utils/permissions/shellRuleMatching",
  "utils/powershell/dangerousCmdlets",
  "utils/powershell/parser",
  "utils/promptCategory",
  "utils/remoteTriggerAudit",
  "utils/sandbox/sandbox-ui-utils",
  "utils/semanticBoolean",
  "utils/semanticNumber",
  "utils/settings/validateEditTool",
  "utils/suggestions/skillUsageTracking",
  "utils/swarm/It2SetupPrompt",
  "utils/swarm/teammateModel",
  "utils/task/sdkProgress",
  "utils/terminal",
  "utils/timeouts",
  "utils/udsClient",
  "voice/voiceModeEnabled",
]

const ENTRY_POINTS = [
  // App entry chain
  "wren/engine.ts",
  "wren/index.ts",
  "QueryEngine.ts",
  "commands.ts",
  "Task.ts",
  "Tool.ts",
  "tools.ts",
  // Bootstrap + core state
  "bootstrap/state.ts",
  "state/AppState.ts",
  "state/onChangeAppState.ts",
  "constants/prompts.ts",
  "constants/systemPromptSections.ts",
  "constants/xml.ts",
  "constants/querySource.ts",
  // Core utils
  "utils/config.ts",
  "utils/sessionStorage.ts",
  "utils/sessionStoragePortable.ts",
  "utils/model/configBridge.ts",
  "utils/model/modelOptions.ts",
  "utils/model/providers.ts",
  "storage/transcriptMirror.ts",
  "cost-tracker.ts",
  "utils/gracefulShutdown.ts",
  "utils/toolResultStorage.ts",
  "utils/fileHistory.ts",
  "utils/messages.ts",
  "utils/attachments.ts",
  "utils/envUtils.ts",
  "utils/errors.ts",
  "utils/log.ts",
  "utils/debug.ts",
  "utils/diagLogs.ts",
  "utils/fsOperations.ts",
  "utils/json.ts",
  "utils/jsonRead.ts",
  "utils/path.ts",
  "utils/cwd.ts",
  "utils/uuid.ts",
  "utils/hash.ts",
  "utils/slowOperations.ts",
  "utils/format.ts",
  "utils/array.ts",
  "utils/semver.ts",
  "utils/intl.ts",
  "utils/language.ts",
  "utils/theme.ts",
  "utils/cleanupRegistry.ts",
  "utils/env.ts",
  "utils/git.ts",
  "utils/forkedAgent.ts",
  "utils/privacyLevel.ts",
  "utils/apiPreconnect.ts",
  "utils/managedEnv.ts",
  "utils/mtls.ts",
  "utils/proxy.ts",
  "utils/caCertsConfig.ts",
  "utils/undercover.ts",
  "utils/errorLogSink.ts",
  "utils/sinks.ts",
  "utils/concurrentSessions.ts",
  "utils/promptShellExecution.ts",
  "utils/windowsPaths.ts",
  "utils/user.ts",
  "utils/ide.ts",
  "utils/auth.ts",
  "utils/fastMode.ts",
  "utils/vcr.ts",
  "utils/plans.ts",
  "utils/context.ts",
  "utils/listSessionsImpl.ts",
  "utils/getWorktreePathsPortable.ts",
  "utils/envDynamic.ts",
  "utils/processUserInput/processUserInput.ts",
  "utils/processUserInput/processSlashCommand.ts",
  "utils/processUserInput/processTextPrompt.ts",
  "utils/abortController.ts",
  "utils/bufferedWriter.ts",
  "utils/agentContext.ts",
  "utils/analyzeContext.ts",
  "utils/api.ts",
  "utils/attribution.ts",
  "utils/autoModeDenials.ts",
  "utils/classifierApprovals.ts",
  "utils/combinedAbortSignal.ts",
  "utils/completionCache.ts",
  "utils/binaryCheck.ts",
  "utils/betas.ts",
  "utils/aws.ts",
  "utils/browser.ts",
  "utils/cachePaths.ts",
  "utils/cleanup.ts",
  "utils/cliArgs.ts",
  "utils/commandLifecycle.ts",
  "utils/query.ts",
  "utils/QueryGuard.ts",
  "utils/CircularBuffer.ts",
  "utils/Cursor.ts",
  "utils/Shell.ts",
  "utils/ShellCommand.ts",
  "utils/agentSwarmsEnabled.ts",
  "utils/teammate.ts",
  "utils/packageVersion.ts",
  "utils/markdown.ts",
  "utils/strings.ts",
  // Query loop
  "query.ts",
  "query/stopHooks.ts",
  "query/deps.ts",
  // Services
  "services/goal/goalStorage.ts",
  "services/goal/goalState.ts",
  "services/goal/prompts.ts",
  "services/compact/autoCompact.ts",
  "services/compact/compact.ts",
  "services/mcp/config.ts",
  "services/mcp/workspace-host.ts",
  "services/lsp/config.ts",
  "services/plugins/builtinPlugins.ts",
  "services/tools/toolExecution.ts",
  "services/tips/index.ts",
  "services/PromptSuggestion/promptSuggestion.ts",
  "services/api/index.ts",
  "services/api/openai/index.ts",
  "services/api/grok/index.ts",
  "services/api/gemini/index.ts",
  "services/api/anthropic/index.ts",
  "services/api/withRetry.ts",
  "services/api/sessionIngress.ts",
  "services/api/dumpPrompts.ts",
  "services/api/claude.ts",
  "services/api/firstTokenDate.ts",
  "services/api/referral.ts",
  "services/api/overageCreditGrant.ts",
  "services/api/metricsOptOut.ts",
  "services/api/bootstrap.ts",
  "services/api/grove.ts",
  "services/claudeAiLimits.ts",
  "services/notifier.ts",
  "services/remoteManagedSettings/settingsCache.ts",
  "services/remoteManagedSettings/policy.ts",
  "services/remoteManagedSettings/syncCacheState.ts",
  "services/skillLearning/observationStore.ts",
  "services/skillLearning/instinctStore.ts",
  "services/SessionMemory/sessionMemory.ts",
  "services/AgentSummary/agentSummary.ts",
  "services/autoDream/autoDream.ts",
  "services/extractMemories/extractMemories.ts",
  // Skills / memdir / plugins
  "skills/loadSkillsDir.ts",
  "skills/bundledSkills.ts",
  "memdir/memdir.ts",
  "memdir/paths.ts",
  // Permissions
  "utils/permissions/PermissionMode.ts",
  "utils/permissions/filesystem.ts",
  "utils/permissions/permissionExplainer.ts",
  "hooks/toolPermission/PermissionContext.ts",
  "hooks/toolPermission/handlers/interactiveHandler.ts",
  "hooks/toolPermission/handlers/autoModeHandler.ts",
  "hooks/toolPermission/handlers/planModeHandler.ts",
  "hooks/toolPermission/handlers/coordinatorHandler.ts",
  "hooks/toolPermission/handlers/nonInteractiveHandler.ts",
  "hooks/toolPermission/permissionLogging.ts",
  // Settings / hooks
  "utils/settings/settings.ts",
  "utils/settings/types.ts",
  "utils/settings/constants.ts",
  "utils/settings/permissionValidation.ts",
  "utils/settings/managedPath.ts",
  "utils/hooks/hooksSettings.ts",
  // Types
  "types/logs.ts",
  "types/message.ts",
  "types/ids.ts",
  "types/command.ts",
  "types/querySource.ts",
  "types/messageQueueTypes.ts",
]

function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue
      out.push(...collectFiles(p))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|\n)\s*\}\s*from\s+['"]([^'"]+)['"]|\bfrom\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveImport(fromFile: string, spec: string): string | null {
  let candidates: string[] = []
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec)
    candidates = extname(base) ? [base] : [base + ".ts", base + ".tsx"]
  } else if (spec.startsWith("src/")) {
    const base = join(ENGINE_SRC, spec.slice(4))
    candidates = extname(base) ? [base] : [base + ".ts", base + ".tsx"]
  } else {
    return null
  }
  for (const cand of candidates) {
    const withTsx = cand.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx")
    for (const c of [withTsx, cand]) {
      try {
        if (statSync(c).isFile()) return c
      } catch {}
      // Directory import: ./foo.js -> foo/index.ts (strip extension first)
      const dirBase = c.replace(/\.(js|ts|tsx|jsx)$/, "")
      if (dirBase !== c) {
        try {
          if (statSync(join(dirBase, "index.ts")).isFile()) return join(dirBase, "index.ts")
        } catch {}
        try {
          if (statSync(join(dirBase, "index.tsx")).isFile()) return join(dirBase, "index.tsx")
        } catch {}
      }
      try {
        if (statSync(join(c, "index.ts")).isFile()) return join(c, "index.ts")
      } catch {}
      try {
        if (statSync(join(c, "index.tsx")).isFile()) return join(c, "index.tsx")
      } catch {}
    }
  }
  return null
}

const allFiles = collectFiles(ENGINE_SRC)
const fileSet = new Set(allFiles)
const reachable = new Set<string>()
const queue: string[] = []

for (const entry of [...ENTRY_POINTS, ...EXTRA_ENTRY_POINTS]) {
  const base = join(ENGINE_SRC, entry)
  for (const p of [base + ".ts", base + ".tsx", base]) {
    if (fileSet.has(p)) {
      queue.push(p)
      break
    }
  }
  if (!queue.includes(join(ENGINE_SRC, entry))) {
    console.error(`WARN: entry not found: ${entry}`)
  }
}

while (queue.length > 0) {
  const file = queue.pop()!
  if (reachable.has(file)) continue
  reachable.add(file)
  const src = readFileSync(file, "utf8")
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
    if (!spec) continue
    const resolved = resolveImport(file, spec)
    if (resolved !== null && fileSet.has(resolved) && !reachable.has(resolved)) {
      queue.push(resolved)
    }
  }
}

const unreachable = allFiles
  .filter((f) => !reachable.has(f) && !f.includes(".test."))
  .sort()
  .map((f) => relative(ENGINE_SRC, f))

const unreachableTests = allFiles
  .filter((f) => !reachable.has(f) && f.includes(".test."))
  .sort()
  .map((f) => relative(ENGINE_SRC, f))

console.log(
  `Total: ${allFiles.length}, reachable: ${reachable.size}, unreachable: ${unreachable.length}, unreachable tests: ${unreachableTests.length}`,
)
console.log("\n=== UNREACHABLE (non-test) ===")
for (const f of unreachable) console.log(f)
console.log("\n=== UNREACHABLE TESTS ===")
for (const f of unreachableTests) console.log(f)

// --- Commands-reachable closure (kept modules: command layer is out of scope) ---
if (process.argv.includes("--commands-closure")) {
  const cmdFiles = collectFiles(join(ENGINE_SRC, "commands"))
  const cmdReachable = new Set<string>()
  const q2: string[] = cmdFiles.filter((f) => !f.includes(".test."))
  while (q2.length > 0) {
    const file = q2.pop()!
    if (cmdReachable.has(file)) continue
    cmdReachable.add(file)
    const src = readFileSync(file, "utf8")
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
      if (!spec) continue
      const resolved = resolveImport(file, spec)
      if (resolved !== null && fileSet.has(resolved) && !cmdReachable.has(resolved)) {
        q2.push(resolved)
      }
    }
  }
  const unreachableSet = new Set(unreachable)
  const keep = [...cmdReachable].filter((f) => unreachableSet.has(relative(ENGINE_SRC, f)))
  console.log(`\n=== UNREACHABLE BUT REACHABLE FROM commands/ (KEEP) ===`)
  for (const f of keep.sort()) console.log(relative(ENGINE_SRC, f))
  const deletable = unreachable.filter((f) => !cmdReachable.has(join(ENGINE_SRC, f)))
  console.log(`\n=== SAFE TO DELETE (unreachable and not referenced by commands/) ===`)
  for (const f of deletable) console.log(f)
}

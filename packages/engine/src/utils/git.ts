import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "fs"
import { realpath } from "fs/promises"
import memoize from "lodash-es/memoize.js"
import { basename, dirname, join, resolve, sep } from "path"
import { getCwd } from "./cwd.js"
import { logForDebugging } from "./debug.js"
import { logForDiagnosticsNoPII } from "./diagLogs.js"
import { execFileNoThrow } from "./execFileNoThrow.js"
import { getFsImplementation } from "./fsOperations.js"
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getWorktreeCountFromFs,
  resolveGitDir,
} from "./git/gitFilesystem.js"
import { memoizeWithLRU } from "./memoize.js"
import { whichSync } from "./which.js"

const GIT_ROOT_NOT_FOUND = Symbol("git-root-not-found")

const findGitRootImpl = memoizeWithLRU(
  (startPath: string): string | typeof GIT_ROOT_NOT_FOUND => {
    const startTime = Date.now()
    logForDiagnosticsNoPII("info", "find_git_root_started")

    let current = resolve(startPath)
    const root = current.substring(0, current.indexOf(sep) + 1) || sep
    let statCount = 0

    while (current !== root) {
      try {
        const gitPath = join(current, ".git")
        statCount++
        const stat = statSync(gitPath)
        // .git can be a directory (regular repo) or file (worktree/submodule)
        if (stat.isDirectory() || stat.isFile()) {
          logForDiagnosticsNoPII("info", "find_git_root_completed", {
            duration_ms: Date.now() - startTime,
            stat_count: statCount,
            found: true,
          })
          return current.normalize("NFC")
        }
      } catch {
        // .git doesn't exist at this level, continue up
      }
      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }

    // Check root directory as well
    try {
      const gitPath = join(root, ".git")
      statCount++
      const stat = statSync(gitPath)
      if (stat.isDirectory() || stat.isFile()) {
        logForDiagnosticsNoPII("info", "find_git_root_completed", {
          duration_ms: Date.now() - startTime,
          stat_count: statCount,
          found: true,
        })
        return root.normalize("NFC")
      }
    } catch {
      // .git doesn't exist at root
    }

    logForDiagnosticsNoPII("info", "find_git_root_completed", {
      duration_ms: Date.now() - startTime,
      stat_count: statCount,
      found: false,
    })
    return GIT_ROOT_NOT_FOUND
  },
  (path) => path,
  50,
)

/**
 * Find the git root by walking up the directory tree.
 * Looks for a .git directory or file (worktrees/submodules use a file).
 * Returns the directory containing .git, or null if not found.
 *
 * Memoized per startPath with an LRU cache (max 50 entries) to prevent
 * unbounded growth — gitDiff calls this with dirname(file), so editing many
 * files across different directories would otherwise accumulate entries forever.
 */
export const findGitRoot = createFindGitRoot()

function createFindGitRoot(): {
  (startPath: string): string | null
  cache: typeof findGitRootImpl.cache
} {
  function wrapper(startPath: string): string | null {
    const result = findGitRootImpl(startPath)
    return result === GIT_ROOT_NOT_FOUND ? null : result
  }
  wrapper.cache = findGitRootImpl.cache
  return wrapper
}

/**
 * Resolve a git root to the canonical main repository root.
 * For a regular repo this is a no-op. For a worktree, follows the
 * `.git` file → `gitdir:` → `commondir` chain to find the main repo's
 * working directory.
 *
 * Submodules (`.git` is a file but no `commondir`) fall through to the
 * input root, which is correct since submodules are separate repos.
 *
 * Memoized with a small LRU to avoid repeated file reads on the hot
 * path (permission checks, prompt building).
 */
const resolveCanonicalRoot = memoizeWithLRU(
  (gitRoot: string): string => {
    try {
      // In a worktree, .git is a file containing: gitdir: <path>
      // In a regular repo, .git is a directory (readFileSync throws EISDIR).
      const gitContent = readFileSync(join(gitRoot, ".git"), "utf-8").trim()
      if (!gitContent.startsWith("gitdir:")) {
        return gitRoot
      }
      const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim())
      // commondir points to the shared .git directory (relative to worktree gitdir).
      // Submodules have no commondir (readFileSync throws ENOENT) → fall through.
      const commonDir = resolve(
        worktreeGitDir,
        readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim(),
      )
      // SECURITY: The .git file and commondir are attacker-controlled in a
      // cloned/downloaded repo. Without validation, a malicious repo can point
      // commondir at any path the victim has trusted, bypassing the trust
      // dialog and executing hooks from .wren/settings.json on startup.
      //
      // Validate the structure matches what `git worktree add` creates:
      //   1. worktreeGitDir is a direct child of <commonDir>/worktrees/
      //      → ensures the commondir file we read lives inside the resolved
      //        common dir, not inside the attacker's repo
      //   2. <worktreeGitDir>/gitdir points back to <gitRoot>/.git
      //      → ensures an attacker can't borrow a victim's existing worktree
      //        entry by guessing its path
      // Both are required: (1) alone fails if victim has a worktree of the
      // trusted repo; (2) alone fails because attacker controls worktreeGitDir.
      if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
        return gitRoot
      }
      // Git writes gitdir with strbuf_realpath() (symlinks resolved), but
      // gitRoot from findGitRoot() is only lexically resolved. Realpath gitRoot
      // so legitimate worktrees accessed via a symlinked path (e.g. macOS
      // /tmp → /private/tmp) aren't rejected. Realpath the directory then join
      // '.git' — realpathing the .git file itself would follow a symlinked .git
      // and let an attacker borrow a victim's back-link.
      const backlink = realpathSync(readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim())
      if (backlink !== join(realpathSync(gitRoot), ".git")) {
        return gitRoot
      }
      // Bare-repo worktrees: the common dir isn't inside a working directory.
      // Use the common dir itself as the stable identity (anthropics/claude-code#27994).
      if (basename(commonDir) !== ".git") {
        return commonDir.normalize("NFC")
      }
      return dirname(commonDir).normalize("NFC")
    } catch {
      return gitRoot
    }
  },
  (root) => root,
  50,
)

/**
 * Find the canonical git repository root, resolving through worktrees.
 *
 * Unlike findGitRoot, which returns the worktree directory (where the `.git`
 * file lives), this returns the main repository's working directory. This
 * ensures all worktrees of the same repo map to the same project identity.
 *
 * Use this instead of findGitRoot for project-scoped state (auto-memory,
 * project config, agent memory) so worktrees share state with the main repo.
 */
export const findCanonicalGitRoot = createFindCanonicalGitRoot()

function createFindCanonicalGitRoot(): {
  (startPath: string): string | null
  cache: typeof resolveCanonicalRoot.cache
} {
  function wrapper(startPath: string): string | null {
    const root = findGitRoot(startPath)
    if (!root) {
      return null
    }
    return resolveCanonicalRoot(root)
  }
  wrapper.cache = resolveCanonicalRoot.cache
  return wrapper
}

export const gitExe = memoize((): string => {
  // Every time we spawn a process, we have to lookup the path.
  // Let's instead avoid that lookup so we only do it once.
  return whichSync("git") || "git"
})

export const getIsGit = memoize(async (): Promise<boolean> => {
  const startTime = Date.now()
  logForDiagnosticsNoPII("info", "is_git_check_started")

  const isGit = findGitRoot(getCwd()) !== null

  logForDiagnosticsNoPII("info", "is_git_check_completed", {
    duration_ms: Date.now() - startTime,
    is_git: isGit,
  })
  return isGit
})

export function getGitDir(cwd: string): Promise<string | null> {
  return resolveGitDir(cwd)
}

export async function isAtGitRoot(): Promise<boolean> {
  const cwd = getCwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    return false
  }
  // Resolve symlinks for accurate comparison
  try {
    const [resolvedCwd, resolvedGitRoot] = await Promise.all([realpath(cwd), realpath(gitRoot)])
    return resolvedCwd === resolvedGitRoot
  } catch {
    return cwd === gitRoot
  }
}

export const dirIsInGitRepo = async (cwd: string): Promise<boolean> => {
  return findGitRoot(cwd) !== null
}

export const getHead = async (): Promise<string> => {
  return getCachedHead()
}

export const getBranch = async (): Promise<string> => {
  return getCachedBranch()
}

export const getDefaultBranch = async (): Promise<string> => {
  return getCachedDefaultBranch()
}

export const getRemoteUrl = async (): Promise<string | null> => {
  return getCachedRemoteUrl()
}

/**
 * Normalizes a git remote URL to a canonical form for hashing.
 * Converts SSH and HTTPS URLs to the same format: host/owner/repo (lowercase, no .git)
 *
 * Examples:
 * - git@github.com:owner/repo.git -> github.com/owner/repo
 * - https://github.com/owner/repo.git -> github.com/owner/repo
 * - ssh://git@github.com/owner/repo -> github.com/owner/repo
 * - http://local_proxy@127.0.0.1:16583/git/owner/repo -> github.com/owner/repo
 */
export function normalizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  // Handle SSH format: git@host:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase()
  }

  // Handle HTTPS/SSH URL format: https://host/owner/repo.git or ssh://git@host/owner/repo
  const urlMatch = trimmed.match(/^(?:https?|ssh):\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/)
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    const host = urlMatch[1]
    const path = urlMatch[2]

    // CCR git proxy URLs use format:
    //   Legacy:  http://...@127.0.0.1:PORT/git/owner/repo       (github.com assumed)
    //   GHE:     http://...@127.0.0.1:PORT/git/ghe.host/owner/repo (host encoded in path)
    // Strip the /git/ prefix. If the first segment contains a dot, it's a
    // hostname (GitHub org names cannot contain dots). Otherwise assume github.com.
    if (isLocalHost(host) && path.startsWith("git/")) {
      const proxyPath = path.slice(4) // Remove "git/" prefix
      const segments = proxyPath.split("/")
      // 3+ segments where first contains a dot → host/owner/repo (GHE format)
      if (segments.length >= 3 && segments[0]!.includes(".")) {
        return proxyPath.toLowerCase()
      }
      // 2 segments → owner/repo (legacy format, assume github.com)
      return `github.com/${proxyPath}`.toLowerCase()
    }

    return `${host}/${path}`.toLowerCase()
  }

  return null
}

/**
 * Returns a SHA256 hash (first 16 chars) of the normalized git remote URL.
 * This provides a globally unique identifier for the repository that:
 * - Is the same regardless of SSH vs HTTPS clone
 * - Does not expose the actual repository name in logs
 */
export async function getRepoRemoteHash(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) return null

  const normalized = normalizeGitRemoteUrl(remoteUrl)
  if (!normalized) return null

  const hash = createHash("sha256").update(normalized).digest("hex")
  return hash.substring(0, 16)
}

export const getIsHeadOnRemote = async (): Promise<boolean> => {
  const { code } = await execFileNoThrow(gitExe(), ["rev-parse", "@{u}"], {
    preserveOutputOnError: false,
  })
  return code === 0
}

export const hasUnpushedCommits = async (): Promise<boolean> => {
  const { stdout, code } = await execFileNoThrow(gitExe(), ["rev-list", "--count", "@{u}..HEAD"], {
    preserveOutputOnError: false,
  })
  return code === 0 && parseInt(stdout.trim(), 10) > 0
}

export const getIsClean = async (options?: { ignoreUntracked?: boolean }): Promise<boolean> => {
  const args = ["--no-optional-locks", "status", "--porcelain"]
  if (options?.ignoreUntracked) {
    args.push("-uno")
  }
  const { stdout } = await execFileNoThrow(gitExe(), args, {
    preserveOutputOnError: false,
  })
  return stdout.trim().length === 0
}

export const getChangedFiles = async (): Promise<string[]> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ["--no-optional-locks", "status", "--porcelain"],
    {
      preserveOutputOnError: false,
    },
  )
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(" ", 2)[1]?.trim()) // Remove status prefix (e.g., "M ", "A ", "??")
    .filter((line) => typeof line === "string") // Remove empty entries
}

export type GitFileStatus = {
  tracked: string[]
  untracked: string[]
}

export const getFileStatus = async (): Promise<GitFileStatus> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ["--no-optional-locks", "status", "--porcelain"],
    {
      preserveOutputOnError: false,
    },
  )

  const tracked: string[] = []
  const untracked: string[] = []

  stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .forEach((line) => {
      const status = line.substring(0, 2)
      const filename = line.substring(2).trim()

      if (status === "??") {
        untracked.push(filename)
      } else if (filename) {
        tracked.push(filename)
      }
    })

  return { tracked, untracked }
}

export const getWorktreeCount = async (): Promise<number> => {
  return getWorktreeCountFromFs()
}

/**
 * Stashes all changes (including untracked files) to return git to a clean porcelain state
 * Important: This function stages untracked files before stashing to prevent data loss
 * @param message - Optional custom message for the stash
 * @returns Promise<boolean> - true if stash was successful, false otherwise
 */
export const stashToCleanState = async (message?: string): Promise<boolean> => {
  try {
    const stashMessage = message || `Wren auto-stash - ${new Date().toISOString()}`

    // First, check if we have untracked files
    const { untracked } = await getFileStatus()

    // If we have untracked files, add them to the index first
    // This prevents them from being deleted
    if (untracked.length > 0) {
      const { code: addCode } = await execFileNoThrow(gitExe(), ["add", ...untracked], {
        preserveOutputOnError: false,
      })

      if (addCode !== 0) {
        return false
      }
    }

    // Now stash everything (staged and unstaged changes)
    const { code } = await execFileNoThrow(gitExe(), ["stash", "push", "--message", stashMessage], {
      preserveOutputOnError: false,
    })
    return code === 0
  } catch (_) {
    return false
  }
}

export type GitRepoState = {
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
}

export async function getGitState(): Promise<GitRepoState | null> {
  try {
    const [commitHash, branchName, remoteUrl, isHeadOnRemote, isClean, worktreeCount] =
      await Promise.all([
        getHead(),
        getBranch(),
        getRemoteUrl(),
        getIsHeadOnRemote(),
        getIsClean(),
        getWorktreeCount(),
      ])

    return {
      commitHash,
      branchName,
      remoteUrl,
      isHeadOnRemote,
      isClean,
      worktreeCount,
    }
  } catch (_) {
    // Fail silently - git state is best effort
    return null
  }
}

export async function getGithubRepo(): Promise<string | null> {
  const { parseGitRemote } = await import("./detectRepository.js")
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    logForDebugging("Local GitHub repo: unknown")
    return null
  }
  // Only return results for github.com — callers assume the result is a github.com repository.
  const parsed = parseGitRemote(remoteUrl)
  if (parsed && parsed.host === "github.com") {
    const result = `${parsed.owner}/${parsed.name}`
    logForDebugging(`Local GitHub repo: ${result}`)
    return result
  }
  logForDebugging("Local GitHub repo: unknown")
  return null
}

function isLocalHost(host: string): boolean {
  const hostWithoutPort = host.split(":")[0] ?? ""
  return hostWithoutPort === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostWithoutPort)
}

/**
 * Checks if the current working directory appears to be a bare git repository
 * or has been manipulated to look like one (sandbox escape attack vector).
 *
 * SECURITY: Git's is_git_directory() function (setup.c:417-455) checks for:
 * 1. HEAD file - Must be a valid ref
 * 2. objects/ directory - Must exist and be accessible
 * 3. refs/ directory - Must exist and be accessible
 *
 * If all three exist in the current directory (not in a .git subdirectory),
 * Git treats the current directory as a bare repository and will execute
 * hooks/pre-commit and other hook scripts from the cwd.
 *
 * Attack scenario:
 * 1. Attacker creates HEAD, objects/, refs/, and hooks/pre-commit in cwd
 * 2. Attacker deletes or corrupts .git/HEAD to invalidate the normal git directory
 * 3. When user runs 'git status', Git treats cwd as the git dir and runs the hook
 *
 * @returns true if the cwd looks like a bare/exploited git directory
 */
/* eslint-disable custom-rules/no-sync-fs -- sync permission-eval check */
export function isCurrentDirectoryBareGitRepo(): boolean {
  const fs = getFsImplementation()
  const cwd = getCwd()

  const gitPath = join(cwd, ".git")
  try {
    const stats = fs.statSync(gitPath)
    if (stats.isFile()) {
      // worktree/submodule — Git follows the gitdir reference
      return false
    }
    if (stats.isDirectory()) {
      const gitHeadPath = join(gitPath, "HEAD")
      try {
        // SECURITY: check isFile(). An attacker creating .git/HEAD as a
        // DIRECTORY would pass a bare statSync but Git's setup_git_directory
        // rejects it (not a valid HEAD) and falls back to cwd discovery.
        if (fs.statSync(gitHeadPath).isFile()) {
          // normal repo — .git/HEAD valid, Git won't fall back to cwd
          return false
        }
        // .git/HEAD exists but is not a regular file — fall through
      } catch {
        // .git exists but no HEAD — fall through to bare-repo check
      }
    }
  } catch {
    // no .git — fall through to bare-repo indicator check
  }

  // No valid .git/HEAD found. Check if cwd has bare git repo indicators.
  // Be cautious — flag if ANY of these exist without a valid .git reference.
  // Per-indicator try/catch so an error on one doesn't mask another.
  try {
    if (fs.statSync(join(cwd, "HEAD")).isFile()) return true
  } catch {
    // no HEAD
  }
  try {
    if (fs.statSync(join(cwd, "objects")).isDirectory()) return true
  } catch {
    // no objects/
  }
  try {
    if (fs.statSync(join(cwd, "refs")).isDirectory()) return true
  } catch {
    // no refs/
  }
  return false
}
/* eslint-enable custom-rules/no-sync-fs */

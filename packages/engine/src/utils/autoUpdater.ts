import axios from "axios"
import { constants as fsConstants } from "fs"
import { access, writeFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { getLocalConfig } from "src/utils/featureGates.js"
import { PACKAGE_URL, VERSION } from "./buildInfo.js"
import { type ReleaseChannel, saveGlobalConfig } from "./config.js"
import { logForDebugging } from "./debug.js"
import { env } from "./env.js"
import { getWrenConfigHomeDir } from "./envUtils.js"
import { WrenError, getErrnoCode, isENOENT } from "./errors.js"
import { execFileNoThrowWithCwd } from "./execFileNoThrow.js"
import { getFsImplementation } from "./fsOperations.js"
import { gracefulShutdownSync } from "./gracefulShutdown.js"
import { logError } from "./log.js"
import { gte, lt } from "./semver.js"
import { getInitialSettings } from "./settings/settings.js"
import { jsonParse } from "./slowOperations.js"

const GCS_BUCKET_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"

class AutoUpdaterError extends WrenError {}

export type InstallStatus = "success" | "no_permissions" | "install_failed" | "in_progress"

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
  notifications?: string[]
}

export type MaxVersionConfig = {
  external?: string
  external_message?: string
}

/**
 * Checks if the current version meets the minimum required version from feature config
 * Terminates the process with an error message if the version is too old
 *
 * NOTE ON SHA-BASED VERSIONING:
 * We use SemVer-compliant versioning with build metadata format (X.X.X+SHA) for continuous deployment.
 * According to SemVer specs, build metadata (the +SHA part) is ignored when comparing versions.
 *
 * Versioning approach:
 * 1. For version requirements/compatibility (assertMinVersion), we use semver comparison that ignores build metadata
 * 2. For updates ('wren update'), we use exact string comparison to detect any change, including SHA
 *    - This ensures users always get the latest build, even when only the SHA changes
 *    - The UI clearly shows both versions including build metadata
 *
 * This approach keeps version comparison logic simple while maintaining traceability via the SHA.
 */
export async function assertMinVersion(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return
  }

  try {
    const versionConfig = await getLocalConfig<{
      minVersion: string
    }>("wren_version_config", { minVersion: "0.0.0" })

    if (versionConfig.minVersion && lt(VERSION, versionConfig.minVersion)) {
      console.error(`
It looks like your version of Wren (${VERSION}) needs an update.
A newer version (${versionConfig.minVersion} or higher) is required to continue.

To update, please run:
    wren update

This will ensure you have access to the latest features and improvements.
`)
      gracefulShutdownSync(1)
    }
  } catch (error) {
    logError(error as Error)
  }
}

/**
 * Returns the maximum allowed version for the current user type.
 * For ants, returns the `ant` field (dev version format).
 * For external users, returns the `external` field (clean semver).
 * This is used as a server-side kill switch to pause auto-updates during incidents.
 * Returns undefined if no cap is configured.
 */
export async function getMaxVersion(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  return config.external || undefined
}

/**
 * Returns the server-driven message explaining the known issue, if configured.
 * Shown in the warning banner when the current version exceeds the max allowed version.
 */
export async function getMaxVersionMessage(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  return config.external_message || undefined
}

async function getMaxVersionConfig(): Promise<MaxVersionConfig> {
  try {
    return await getLocalConfig<MaxVersionConfig>("wren_max_version_config", {})
  } catch (error) {
    logError(error as Error)
    return {}
  }
}

/**
 * Checks if a target version should be skipped due to user's minimumVersion setting.
 * This is used when switching to stable channel - the user can choose to stay on their
 * current version until stable catches up, preventing downgrades.
 */
export function shouldSkipVersion(targetVersion: string): boolean {
  const settings = getInitialSettings()
  const minimumVersion = settings?.minimumVersion
  if (!minimumVersion) {
    return false
  }
  // Skip if target version is less than minimum
  const shouldSkip = !gte(targetVersion, minimumVersion)
  if (shouldSkip) {
    logForDebugging(`Skipping update to ${targetVersion} - below minimumVersion ${minimumVersion}`)
  }
  return shouldSkip
}

// Lock file for auto-updater to prevent concurrent updates
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minute timeout for locks

/**
 * Get the path to the lock file
 * This is a function to ensure it's evaluated at runtime after test setup
 */
export function getLockFilePath(): string {
  return join(getWrenConfigHomeDir(), ".update.lock")
}

/**
 * Attempts to acquire a lock for auto-updater
 * @returns true if lock was acquired, false if another process holds the lock
 */
async function acquireLock(): Promise<boolean> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()

  // Check for existing lock: 1 stat() on the happy path (fresh lock or ENOENT),
  // 2 on stale-lock recovery (re-verify staleness immediately before unlink).
  try {
    const stats = await fs.stat(lockPath)
    const age = Date.now() - stats.mtimeMs
    if (age < LOCK_TIMEOUT_MS) {
      return false
    }
    // Lock is stale, remove it before taking over. Re-verify staleness
    // immediately before unlinking to close a TOCTOU race: if two processes
    // both observe the stale lock, A unlinks + writes a fresh lock, then B
    // would unlink A's fresh lock and both believe they hold it. A fresh
    // lock has a recent mtime, so re-checking staleness makes B back off.
    try {
      const recheck = await fs.stat(lockPath)
      if (Date.now() - recheck.mtimeMs < LOCK_TIMEOUT_MS) {
        return false
      }
      await fs.unlink(lockPath)
    } catch (err) {
      if (!isENOENT(err)) {
        logError(err as Error)
        return false
      }
    }
  } catch (err) {
    if (!isENOENT(err)) {
      logError(err as Error)
      return false
    }
    // ENOENT: no lock file, proceed to create one
  }

  // Create lock file atomically with O_EXCL (flag: 'wx'). If another process
  // wins the race and creates it first, we get EEXIST and back off.
  // Lazy-mkdir the config dir on ENOENT.
  try {
    await writeFile(lockPath, `${process.pid}`, {
      encoding: "utf8",
      flag: "wx",
    })
    return true
  } catch (err) {
    const code = getErrnoCode(err)
    if (code === "EEXIST") {
      return false
    }
    if (code === "ENOENT") {
      try {
        // fs.mkdir from getFsImplementation() is always recursive:true and
        // swallows EEXIST internally, so a dir-creation race cannot reach the
        // catch below — only writeFile's EEXIST (true lock contention) can.
        await fs.mkdir(getWrenConfigHomeDir())
        await writeFile(lockPath, `${process.pid}`, {
          encoding: "utf8",
          flag: "wx",
        })
        return true
      } catch (mkdirErr) {
        if (getErrnoCode(mkdirErr) === "EEXIST") {
          return false
        }
        logError(mkdirErr as Error)
        return false
      }
    }
    logError(err as Error)
    return false
  }
}

/**
 * Releases the update lock if it's held by this process
 */
async function releaseLock(): Promise<void> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()
  try {
    const lockData = await fs.readFile(lockPath, { encoding: "utf8" })
    if (lockData === `${process.pid}`) {
      await fs.unlink(lockPath)
    }
  } catch (err) {
    if (isENOENT(err)) {
      return
    }
    logError(err as Error)
  }
}

async function getInstallationPrefix(): Promise<string | null> {
  // Run from home directory to avoid reading project-level .npmrc/.bunfig.toml
  const isBun = env.isRunningWithBun()
  let prefixResult = null
  if (isBun) {
    prefixResult = await execFileNoThrowWithCwd("bun", ["pm", "bin", "-g"], {
      cwd: homedir(),
    })
  } else {
    prefixResult = await execFileNoThrowWithCwd("npm", ["-g", "config", "get", "prefix"], {
      cwd: homedir(),
    })
  }
  if (prefixResult.code !== 0) {
    logError(new Error(`Failed to check ${isBun ? "bun" : "npm"} permissions`))
    return null
  }
  return prefixResult.stdout.trim()
}

export async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefix = await getInstallationPrefix()
    if (!prefix) {
      return { hasPermissions: false, npmPrefix: null }
    }

    try {
      await access(prefix, fsConstants.W_OK)
      return { hasPermissions: true, npmPrefix: prefix }
    } catch {
      logError(new AutoUpdaterError("Insufficient permissions for global npm install."))
      return { hasPermissions: false, npmPrefix: prefix }
    }
  } catch (error) {
    logError(error as Error)
    return { hasPermissions: false, npmPrefix: null }
  }
}

export async function getLatestVersion(channel: ReleaseChannel): Promise<string | null> {
  const npmTag = channel === "stable" ? "stable" : "latest"

  // Run from home directory to avoid reading project-level .npmrc
  // which could be maliciously crafted to redirect to an attacker's registry
  const result = await execFileNoThrowWithCwd(
    "npm",
    ["view", `${PACKAGE_URL}@${npmTag}`, "version", "--prefer-online"],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    } else {
      logForDebugging("npm stderr: (empty)")
    }
    if (result.stdout) {
      logForDebugging(`npm stdout: ${result.stdout.trim()}`)
    }
    return null
  }
  return result.stdout.trim()
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

/**
 * Get npm dist-tags (latest and stable versions) from the registry.
 * This is used by the doctor command to show users what versions are available.
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    "npm",
    ["view", PACKAGE_URL, "dist-tags", "--json", "--prefer-online"],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view dist-tags failed with code ${result.code}`)
    return { latest: null, stable: null }
  }

  try {
    const parsed = jsonParse(result.stdout.trim()) as Record<string, unknown>
    return {
      latest: typeof parsed.latest === "string" ? parsed.latest : null,
      stable: typeof parsed.stable === "string" ? parsed.stable : null,
    }
  } catch (error) {
    logForDebugging(`Failed to parse dist-tags: ${error}`)
    return { latest: null, stable: null }
  }
}

/**
 * Get the latest version from GCS bucket for a given release channel.
 * This is used by installations that don't have npm (e.g. package manager installs).
 */
export async function getLatestVersionFromGcs(channel: ReleaseChannel): Promise<string | null> {
  try {
    const response = await axios.get(`${GCS_BUCKET_URL}/${channel}`, {
      timeout: 5000,
      responseType: "text",
    })
    return response.data.trim()
  } catch (error) {
    logForDebugging(`Failed to fetch ${channel} from GCS: ${error}`)
    return null
  }
}

/**
 * Get available versions from GCS bucket (for native installations).
 * Fetches both latest and stable channel pointers.
 */
export async function getGcsDistTags(): Promise<NpmDistTags> {
  const [latest, stable] = await Promise.all([
    getLatestVersionFromGcs("latest"),
    getLatestVersionFromGcs("stable"),
  ])

  return { latest, stable }
}

/**
 * Get version history from npm registry.
 * Returns versions sorted newest-first, limited to the specified count.
 * Returns empty array (not available for external users).
 */
export async function getVersionHistory(limit: number): Promise<string[]> {
  return []
}

export async function installGlobalPackage(
  specificVersion?: string | null,
): Promise<InstallStatus> {
  if (!(await acquireLock())) {
    logError(new AutoUpdaterError("Another process is currently installing an update"))
    // Log the lock contention
    return "in_progress"
  }

  try {
    // Check if we're using npm from Windows path in WSL
    if (!env.isRunningWithBun() && env.isNpmFromWindowsPath()) {
      logError(new Error("Windows NPM detected in WSL environment"))
      console.error(`
Error: Windows NPM detected in WSL

You're running Wren in WSL but using the Windows NPM installation from /mnt/c/.
This configuration is not supported for updates.

To fix this issue:
  1. Install Node.js within your Linux distribution: e.g. sudo apt install nodejs npm
  2. Make sure Linux NPM is in your PATH before the Windows version
  3. Try updating again with 'wren update'
`)
      return "install_failed"
    }

    const { hasPermissions } = await checkGlobalInstallPermissions()
    if (!hasPermissions) {
      return "no_permissions"
    }

    // Use specific version if provided, otherwise use latest
    const packageSpec = specificVersion ? `${PACKAGE_URL}@${specificVersion}` : PACKAGE_URL

    // Run from home directory to avoid reading project-level .npmrc/.bunfig.toml
    // which could be maliciously crafted to redirect to an attacker's registry
    const packageManager = env.isRunningWithBun() ? "bun" : "npm"
    const installResult = await execFileNoThrowWithCwd(
      packageManager,
      ["install", "-g", packageSpec],
      { cwd: homedir() },
    )
    if (installResult.code !== 0) {
      const error = new AutoUpdaterError(
        `Failed to install new version of wren: ${installResult.stdout} ${installResult.stderr}`,
      )
      logError(error)
      return "install_failed"
    }

    // Set installMethod to 'global' to track npm global installations
    saveGlobalConfig((current) => ({
      ...current,
      installMethod: "global",
    }))

    return "success"
  } finally {
    // Ensure we always release the lock
    await releaseLock()
  }
}

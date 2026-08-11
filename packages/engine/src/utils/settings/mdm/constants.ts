/**
 * Shared constants and path builders for MDM settings modules.
 *
 * This module has ZERO heavy imports (only `os`) — safe to use from mdmRawRead.ts.
 * Both mdmRawRead.ts and mdmSettings.ts import from here to avoid duplication.
 */

import { userInfo } from "os"

/** macOS preference domain for Wren MDM profiles. */
export const MACOS_PREFERENCE_DOMAIN = "dev.wren.wren"

/**
 * Windows registry key paths for Wren MDM policies.
 *
 * These keys live under SOFTWARE\Policies which is on the WOW64 shared key
 * list — both 32-bit and 64-bit processes see the same values without
 * redirection. Do not move these to SOFTWARE\Wren, as SOFTWARE is
 * redirected and 32-bit processes would silently read from WOW6432Node.
 * See: https://learn.microsoft.com/en-us/windows/win32/winprog64/shared-registry-keys
 */
export const WINDOWS_REGISTRY_KEY_PATH_HKLM = "HKLM\\SOFTWARE\\Policies\\Wren"
export const WINDOWS_REGISTRY_KEY_PATH_HKCU = "HKCU\\SOFTWARE\\Policies\\Wren"

/** Windows registry value name containing the JSON settings blob. */
export const WINDOWS_REGISTRY_VALUE_NAME = "Settings"

/** Path to macOS plutil binary. */
export const PLUTIL_PATH = "/usr/bin/plutil"

/** Arguments for plutil to convert plist to JSON on stdout (append plist path). */
export const PLUTIL_ARGS_PREFIX = ["-convert", "json", "-o", "-", "--"] as const

/** Subprocess timeout in milliseconds. */
export const MDM_SUBPROCESS_TIMEOUT_MS = 5000

/**
 * Build the list of macOS plist paths in priority order (highest first).
 */
export function getMacOSPlistPaths(): Array<{ path: string; label: string }> {
  let username = ""
  try {
    username = userInfo().username
  } catch {
    // ignore
  }

  const paths: Array<{ path: string; label: string }> = []

  if (username) {
    paths.push({
      path: `/Library/Managed Preferences/${username}/${MACOS_PREFERENCE_DOMAIN}.plist`,
      label: "per-user managed preferences",
    })
  }

  paths.push({
    path: `/Library/Managed Preferences/${MACOS_PREFERENCE_DOMAIN}.plist`,
    label: "device-level managed preferences",
  })

  return paths
}

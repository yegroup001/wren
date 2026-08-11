import memoize from "lodash-es/memoize.js"
import { join } from "path"
import { getPlatform } from "../platform.js"

/**
 * Get the path to the managed settings directory based on the current platform.
 */
export const getManagedFilePath = memoize((): string => {
  // Allow override for testing/demos
  if (process.env.WREN_MANAGED_SETTINGS_PATH) {
    return process.env.WREN_MANAGED_SETTINGS_PATH
  }

  switch (getPlatform()) {
    case "macos":
      return "/Library/Application Support/Wren"
    case "windows":
      return "C:\\Program Files\\Wren"
    default:
      return "/etc/wren"
  }
})

/**
 * Get the path to the managed-settings.d/ drop-in directory.
 * managed-settings.json is merged first (base), then files in this directory
 * are merged alphabetically on top (drop-ins override base, later files win).
 */
export const getManagedSettingsDropInDir = memoize((): string =>
  join(getManagedFilePath(), "managed-settings.d"),
)

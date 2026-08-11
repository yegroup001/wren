/**
 * Download functionality for native installer
 *
 * Binary downloads from a release bucket are not configured for this fork.
 * Users should update via npm or the package manager they installed with.
 */

export async function getLatestVersion(_channelOrVersion: string): Promise<string> {
  throw new Error(
    "Binary update channel is not configured. Please update via npm: npm install -g @wren/cli",
  )
}

export async function downloadVersion(
  _version: string,
  _stagingPath: string,
): Promise<"npm" | "binary"> {
  throw new Error(
    "Binary downloads are not configured for this fork. Please update via npm.",
  )
}

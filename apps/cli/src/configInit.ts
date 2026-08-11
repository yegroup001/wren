import { initConfig } from "@wren/engine"

export async function initWrenConfig(explicitPath?: string, cwd?: string): Promise<void> {
  await initConfig(explicitPath, cwd)
}

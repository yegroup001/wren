/**
 * Utilities for managing shell configuration files (like .bashrc, .zshrc).
 * Computes the active shell type and the paths to shell config files.
 */

import { homedir as osHomedir } from "os"
import { join } from "path"

type EnvLike = Record<string, string | undefined>

type ShellConfigOptions = {
  env?: EnvLike
  homedir?: string
}

/**
 * Get the paths to shell configuration files
 * Respects ZDOTDIR for zsh users
 * @param options Optional overrides for testing (env, homedir)
 */
export function getShellConfigPaths(options?: ShellConfigOptions): Record<string, string> {
  const home = options?.homedir ?? osHomedir()
  const env = options?.env ?? process.env
  const zshConfigDir = env.ZDOTDIR || home
  return {
    zsh: join(zshConfigDir, ".zshrc"),
    bash: join(home, ".bashrc"),
    fish: join(home, ".config/fish/config.fish"),
  }
}

/**
 * Get the active shell type to determine appropriate path setup
 */
export function getShellType(): string {
  const shellPath = process.env.SHELL || ""
  if (shellPath.includes("zsh")) return "zsh"
  if (shellPath.includes("bash")) return "bash"
  if (shellPath.includes("fish")) return "fish"
  return "unknown"
}

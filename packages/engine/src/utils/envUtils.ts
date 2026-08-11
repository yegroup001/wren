import { getWrenConfigHome } from "@wren/config-node"
import memoize from "lodash-es/memoize.js"
import { join } from "path"

// Memoized: 150+ callers, many on hot paths. Tests override via
// setWrenConfigHomeForTests() and call clearConfigHomeCache().
export const getWrenConfigHomeDir = memoize((): string => getWrenConfigHome())

export function clearConfigHomeCache(): void {
  getWrenConfigHomeDir.cache.clear?.()
}

export function getTeamsDir(): string {
  return join(getWrenConfigHomeDir(), "teams")
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === "boolean") return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ["1", "true", "yes", "on"].includes(normalizedValue)
}

export function isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === "boolean") return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ["0", "false", "no", "off"].includes(normalizedValue)
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(rawEnvArgs: string[] | undefined): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split("=")
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join("=")
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || "us-east5"
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if WREN_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.WREN_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ["claude-haiku-4-5", "VERTEX_REGION_WREN_HAIKU_4_5"],
  ["claude-3-5-haiku", "VERTEX_REGION_WREN_3_5_HAIKU"],
  ["claude-3-5-sonnet", "VERTEX_REGION_WREN_3_5_SONNET"],
  ["claude-3-7-sonnet", "VERTEX_REGION_WREN_3_7_SONNET"],
  ["claude-opus-4-1", "VERTEX_REGION_WREN_4_1_OPUS"],
  ["claude-opus-4", "VERTEX_REGION_WREN_4_0_OPUS"],
  ["claude-sonnet-4-6", "VERTEX_REGION_WREN_4_6_SONNET"],
  ["claude-sonnet-4-5", "VERTEX_REGION_WREN_4_5_SONNET"],
  ["claude-sonnet-4", "VERTEX_REGION_WREN_4_0_SONNET"],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(model: string | undefined): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) => model.startsWith(prefix))
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}

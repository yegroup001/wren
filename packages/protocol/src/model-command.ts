import type { ModelRef, ModelScope } from "./model-contract"

export type ModelCommand =
  | { verb: "open" }
  | { verb: "set"; ref: ModelRef; scope?: ModelScope }
  | { verb: "list" }
  | { verb: "status" }
  | { verb: "manage" }
  | { verb: "test"; ref: ModelRef }

const MODEL_COMMAND = "/models"
const SET_SCOPES = new Map<string, ModelScope>([
  ["--session", "session"],
  ["--project", "workspace"],
  ["--user", "user"],
  ["--workspace", "workspace"],
])

function isModelsCommand(input: string): boolean {
  return input === MODEL_COMMAND || input.startsWith(`${MODEL_COMMAND} `)
}

function parseModelRef(id: string): ModelRef {
  const slashIdx = id.indexOf("/")
  if (slashIdx <= 0 || slashIdx === id.length - 1) {
    throw new Error(`Model reference "${id}" must use <source>/<model>`)
  }
  const providerId = id.slice(0, slashIdx)
  const modelId = id.slice(slashIdx + 1)
  return { providerId, modelId }
}

export function parseModelCommand(input: string): ModelCommand {
  const trimmed = input.trim()
  if (!isModelsCommand(trimmed)) {
    throw new Error(`Not a models command: ${trimmed}`)
  }

  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 1) {
    return { verb: "open" }
  }

  const firstArg = tokens[1]
  if (firstArg === undefined) {
    throw new Error("Missing argument")
  }

  if (firstArg === "set") {
    const modelId = tokens[2]
    if (modelId === undefined || modelId.length === 0) {
      throw new Error("Usage: /models set <id> [--session|--project|--user]")
    }
    const scopeFlag = tokens[3]
    let scope: ModelScope | undefined
    if (scopeFlag !== undefined) {
      const resolved = SET_SCOPES.get(scopeFlag)
      if (resolved === undefined) {
        throw new Error(`Unknown scope: ${scopeFlag}. Use --session, --project, or --user`)
      }
      scope = resolved
    }
    if (scope !== undefined) {
      return { verb: "set", ref: parseModelRef(modelId), scope }
    }
    return { verb: "set", ref: parseModelRef(modelId) }
  }

  if (firstArg === "list") return { verb: "list" }
  if (firstArg === "status") return { verb: "status" }
  if (firstArg === "manage") return { verb: "manage" }

  if (firstArg === "test") {
    const modelId = tokens[2]
    if (modelId === undefined || modelId.length === 0) {
      throw new Error("Usage: /models test <id>")
    }
    return { verb: "test", ref: parseModelRef(modelId) }
  }

  return { verb: "set", ref: parseModelRef(firstArg), scope: "session" }
}

export function isModelCommand(input: string): boolean {
  return isModelsCommand(input.trim())
}

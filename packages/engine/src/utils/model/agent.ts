// Per-agentType model resolution for AgentTool subagents.
//
// config.agentModels maps an agent type string to an explicit
// { source, model, effort? } reference. Unspecified agent types use
// defaultModel (the main loop model).

import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import { getRuntimeMainLoopModel, parseUserSpecifiedModel } from './model.js'
import {
  formatModelReference,
  getConfig,
  getModelEffort,
  resolveModelReference,
} from './configBridge.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Resolve the effort level for a subagent. Priority:
 * 1. Agent definition's effort field
 * 2. The configured agentModels reference's effort
 * 3. The resolved model's configured effort
 * 4. undefined (let the model decide)
 */
export function getAgentEffort(
  agentType: string | undefined,
  agentModel: string | undefined,
  resolvedModel: string | undefined,
): string | undefined {
  const config = getConfig()

  if (agentType !== undefined) {
    const configured = config.agentModels?.[agentType]
    if (configured?.effort !== undefined) return configured.effort
  }

  const modelToCheck = resolvedModel ?? agentModel
  if (modelToCheck === undefined || modelToCheck === "inherit") return undefined
  return getModelEffort(modelToCheck)
}

function findConfiguredModel(config: ReturnType<typeof getConfig>, modelId: string): string | undefined {
  const matches = Object.entries(config.sources).flatMap(([source, provider]) =>
    Object.prototype.hasOwnProperty.call(provider.models, modelId)
      ? [formatModelReference({ source, model: modelId })]
      : [],
  )
  return matches.length === 1 ? matches[0] : undefined
}

function resolveSelection(config: ReturnType<typeof getConfig>, spec: string): string {
  if (spec === "inherit") {
    return getRuntimeMainLoopModel({
      permissionMode: "default",
      mainLoopModel: formatModelReference(config.defaultModel),
      exceeds200kTokens: false,
    })
  }
  try {
    return formatModelReference(resolveModelReference(config, spec))
  } catch {
    const parsed = parseUserSpecifiedModel(spec)
    return findConfiguredModel(config, parsed) ?? parsed
  }
}

export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  agentType?: string,
  permissionMode?: PermissionMode,
): string {
  const config = getConfig()

  const resolve = (spec: string): string => {
    if (spec === "inherit") {
      return getRuntimeMainLoopModel({
        permissionMode: permissionMode ?? "default",
        mainLoopModel: parentModel,
        exceeds200kTokens: false,
      })
    }
    return resolveSelection(config, spec)
  }

  if (toolSpecifiedModel) return resolve(toolSpecifiedModel)
  if (agentModel) return resolve(agentModel)
  if (agentType !== undefined) {
    const configured = config.agentModels?.[agentType]
    if (configured !== undefined) {
      return formatModelReference(configured)
    }
  }
  return resolve("inherit")
}

function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  return resolveSelection(getConfig(), alias) === parentModel
}

export function getAgentModelDisplay(model: string | undefined): string {
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

export function getAgentModelOptions(): AgentModelOption[] {
  const config = getConfig()
  const options: AgentModelOption[] = [
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
  for (const [agentType, reference] of Object.entries(config.agentModels ?? {})) {
    options.push({
      value: agentType as AgentModelAlias,
      label: capitalize(agentType),
      description: formatModelReference(reference),
    })
  }
  for (const [source, provider] of Object.entries(config.sources)) {
    for (const [modelId, modelConfig] of Object.entries(provider.models)) {
      const value = `${source}/${modelId}`
      options.push({
        value: value as AgentModelAlias,
        label: modelConfig.displayName ?? value,
        description: `${modelConfig.contextWindow.toLocaleString()} context`,
      })
    }
  }
  return options
}

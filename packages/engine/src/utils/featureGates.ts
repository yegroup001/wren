const LOCAL_FEATURE_DEFAULTS: Record<string, unknown> = {
  wren_keybinding_customization_release: true,
  wren_streaming_tool_execution2: true,
  wren_kairos_cron: true,
  wren_amber_json_tools: true,
  wren_immediate_model_command: true,
  wren_basalt_3kr: true,
  wren_pebble_leaf_prune: true,
  wren_chair_sermon: true,
  wren_lodestone_enabled: true,
  wren_auto_background_agents: true,
  wren_fgts: true,
  wren_session_memory: true,
  wren_passport_quail: true,
  wren_moth_copse: true,
  wren_coral_fern: true,
  wren_chomp_inflection: true,
  wren_hive_evidence: true,
  wren_kairos_brief: true,
  wren_kairos_brief_config: { enable_slash_command: true },
  wren_sedge_lantern: true,
  wren_onyx_plover: { enabled: true },
  wren_willow_mode: "dialog",
  wren_turtle_carbon: true,
  wren_amber_stoat: true,
  wren_amber_flint: true,
  wren_slim_subagent_wrenmd: true,
  wren_birch_trellis: true,
  wren_collage_kaleidoscope: true,
  wren_compact_cache_prefix: true,
  wren_kairos_assistant: true,
  wren_kairos_cron_durable: true,
  wren_attribution_header: true,
  wren_slate_prism: true,
  wren_review_bughunter_config: { enabled: true },
  wren_ccr_bundle_seed_enabled: true,
}

let featureGateOverrides: Record<string, unknown> | null = null

export function setFeatureGateOverride(feature: string, value: unknown): void {
  featureGateOverrides ??= {}
  featureGateOverrides[feature] = value
}

export function clearFeatureGateOverrides(): void {
  featureGateOverrides = null
}

export function getLocalFeatureValue<T>(feature: string, defaultValue: T): T {
  if (featureGateOverrides && feature in featureGateOverrides) {
    return featureGateOverrides[feature] as T
  }
  const localDefault = LOCAL_FEATURE_DEFAULTS[feature]
  return localDefault !== undefined ? (localDefault as T) : defaultValue
}

export function isLocalFeatureEnabled(feature: string): boolean {
  return Boolean(getLocalFeatureValue(feature, false))
}

export function getLocalFeatureValueWithRefresh<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return getLocalFeatureValue(feature, defaultValue)
}

export function checkLocalSecurityGate(feature: string): boolean {
  return isLocalFeatureEnabled(feature)
}

export function checkLocalGate(feature: string): boolean {
  return isLocalFeatureEnabled(feature)
}

export function getLocalConfig<T>(configName: string, defaultValue: T): T {
  return getLocalFeatureValue(configName, defaultValue)
}

export function getLocalFeatureFlags(): Record<string, unknown> {
  return { ...LOCAL_FEATURE_DEFAULTS, ...(featureGateOverrides ?? {}) }
}

export function getFeatureGateOverrides(): Record<string, unknown> | null {
  return featureGateOverrides
}

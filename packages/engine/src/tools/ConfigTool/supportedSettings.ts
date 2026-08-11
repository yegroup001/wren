import { EDITOR_MODES, NOTIFICATION_CHANNELS, TEAMMATE_MODES } from "src/utils/configConstants.js"
import { getModelOptions } from "src/utils/model/modelOptions.js"
import { validateModel } from "src/utils/model/validateModel.js"
import { THEME_NAMES } from "src/utils/theme.js"

/** AppState keys that can be synced for immediate UI effect */
type SyncableAppStateKey = "verbose" | "mainLoopModel" | "thinkingEnabled"

type SettingConfig = {
  source: "global" | "settings"
  type: "boolean" | "string"
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** Async validation called when writing/setting a value */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** Format value when reading/getting for display */
  formatOnRead?: (v: unknown) => unknown
}

export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  theme: {
    source: "global",
    type: "string",
    description: "Color theme for the UI",
    options: THEME_NAMES,
  },
  editorMode: {
    source: "global",
    type: "string",
    description: "Key binding mode",
    options: EDITOR_MODES,
  },
  verbose: {
    source: "global",
    type: "boolean",
    description: "Show detailed debug output",
    appStateKey: "verbose",
  },
  preferredNotifChannel: {
    source: "global",
    type: "string",
    description: "Preferred notification channel",
    options: NOTIFICATION_CHANNELS,
  },
  autoCompactEnabled: {
    source: "global",
    type: "boolean",
    description: "Auto-compact when context is full",
  },
  autoMemoryEnabled: {
    source: "settings",
    type: "boolean",
    description: "Enable auto-memory",
  },
  autoDreamEnabled: {
    source: "settings",
    type: "boolean",
    description: "Enable background memory consolidation",
  },
  fileCheckpointingEnabled: {
    source: "global",
    type: "boolean",
    description: "Enable file checkpointing for code rewind",
  },
  showTurnDuration: {
    source: "global",
    type: "boolean",
    description: 'Show turn duration message after responses (e.g., "Cooked for 1m 6s")',
  },
  terminalProgressBarEnabled: {
    source: "global",
    type: "boolean",
    description: "Show OSC 9;4 progress indicator in supported terminals",
  },
  model: {
    source: "settings",
    type: "string",
    description: "Override the default model",
    appStateKey: "mainLoopModel",
    getOptions: () => {
      try {
        return getModelOptions()
          .filter((o) => o.value !== null)
          .map((o) => o.value as string)
      } catch {
        return ["sonnet", "opus", "haiku"]
      }
    },
    validateOnWrite: (v) => validateModel(String(v)),
    formatOnRead: (v) => (v === null ? "default" : v),
  },
  alwaysThinkingEnabled: {
    source: "settings",
    type: "boolean",
    description: "Enable extended thinking (false to disable)",
    appStateKey: "thinkingEnabled",
  },
  "permissions.defaultMode": {
    source: "settings",
    type: "string",
    description: "Default permission mode for tool usage",
    options: ["default", "plan", "acceptEdits", "dontAsk"],
  },
  language: {
    source: "settings",
    type: "string",
    description:
      'Preferred language for Wren responses and voice dictation (e.g., "japanese", "spanish")',
  },
  teammateMode: {
    source: "global",
    type: "string",
    description:
      'How to spawn teammates: "tmux" for traditional tmux, "in-process" for same process, "auto" to choose automatically',
    options: TEAMMATE_MODES,
  },
  classifierPermissionsEnabled: {
    source: "settings" as const,
    type: "boolean" as const,
    description: "Enable AI-based classification for Bash(prompt:...) permission rules",
  },
}

export function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS
}

export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}

export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  return config?.path ?? key.split(".")
}

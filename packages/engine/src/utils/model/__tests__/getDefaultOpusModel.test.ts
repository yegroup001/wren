import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetModelStringsForTestingOnly } from "src/bootstrap/state.js"
import { resetSettingsCache, setSessionSettingsCache } from "src/utils/settings/settingsCache.js"
import { formatModelReference, setConfigForTests, type WrenConfig } from "../configBridge.js"
import { ALL_MODEL_CONFIGS } from "../configs.js"
import { getDefaultOpusModel, getMainLoopModel } from "../model.js"
import { getOpus46Option } from "../modelOptions.js"
import { getModelStrings } from "../modelStrings.js"

const envKeys = [
  "WREN_USE_GEMINI",
  "WREN_USE_BEDROCK",
  "WREN_USE_VERTEX",
  "WREN_USE_FOUNDRY",
  "WREN_USE_OPENAI",
  "WREN_USE_GROK",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "OPENAI_DEFAULT_OPUS_MODEL",
  "GEMINI_DEFAULT_OPUS_MODEL",
] as const

const savedEnv: Record<string, string | undefined> = {}

const testConfig: WrenConfig = {
  defaultModel: { source: "anthropic", model: "claude-opus-4-7" },
    fast: { source: "anthropic", model: "claude-haiku-4-5" },
  },
  sources: {
    anthropic: {
      type: "anthropic",
      apiKey: "test-key",
      models: {
        "claude-opus-4-7": {
          contextWindow: 200000,
          supportsThinking: true,
          reasoningMode: "adaptive",
        },
        "claude-opus-4-6": {
          contextWindow: 200000,
          supportsThinking: true,
          reasoningMode: "adaptive",
        },
        "claude-sonnet-4-6": {
          contextWindow: 200000,
          supportsThinking: true,
          reasoningMode: "adaptive",
        },
        "claude-haiku-4-5": {
          contextWindow: 200000,
          supportsThinking: true,
          reasoningMode: "adaptive",
        },
      },
    },
  },
}

function resetProviderState(): void {
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
  resetModelStringsForTestingOnly()
}

describe("getDefaultOpusModel", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    resetProviderState()
    setConfigForTests(testConfig)
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    resetProviderState()
    setConfigForTests(null)
  })

  test("returns the config reasoning role as a source-qualified reference", () => {
    expect(getDefaultOpusModel()).toBe("anthropic/claude-opus-4-7")
  })

  test("falls back to defaultModel when roles.reasoning is absent", () => {
    const configWithoutRoles: WrenConfig = {
      ...testConfig,
      roles: undefined,
      defaultModel: { source: "anthropic", model: "claude-opus-4-6" },
    }
    setConfigForTests(configWithoutRoles)
    expect(getDefaultOpusModel()).toBe("anthropic/claude-opus-4-6")
  })

  test("returns the same value as getMainLoopModel when roles.reasoning equals defaultModel", () => {
    setConfigForTests({
      ...testConfig,
      roles: undefined,
    })
    expect(getDefaultOpusModel()).toBe(getMainLoopModel())
  })
})

describe("getOpus46Option", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    resetProviderState()
    setConfigForTests(testConfig)
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    resetProviderState()
    setConfigForTests(null)
  })

  test("firstParty: value is canonical opus46 string, NOT opus alias", () => {
    const opt = getOpus46Option(false)
    expect(opt.value).toBe(getModelStrings().opus46)
    expect(opt.value).not.toBe("opus")
    expect(opt.label).toBe("Opus 4.6")
  })

  test('firstParty: description says "Previous generation", not "Legacy"', () => {
    const opt = getOpus46Option(false)
    expect(opt.description).toContain("Previous generation")
    expect(opt.description).not.toContain("Legacy")
  })

  test("value is canonical opus46 string matching the config provider", () => {
    const opt = getOpus46Option(false)
    expect(opt.value).toBe(getModelStrings().opus46)
    expect(opt.value).toBe(ALL_MODEL_CONFIGS.opus46.firstParty)
  })

  test("option has descriptionForModel that mentions Opus 4.6", () => {
    const opt = getOpus46Option(false)
    expect(opt.descriptionForModel).toBeDefined()
    expect(opt.descriptionForModel).toContain("Opus 4.6")
  })
})

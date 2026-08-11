import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getConfigPaths,
  loadWrenConfig,
  patchWrenUserConfig,
  setWrenConfigHomeForTests,
} from "./index"

const validConfig = {
  defaultModel: { source: "test", model: "user-model" },
  smallFastModel: { source: "test", model: "user-model" },
  sources: {
    test: {
      type: "openai-compatible-chat" as const,
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key-not-real",
      models: {
        "user-model": {
          contextWindow: 128000,
          supportsThinking: false,
        },
      },
    },
  },
}

describe("Wren config loading", () => {
  test("uses only the user config as the implicit source", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-scope-"))
    const userHome = join(root, "user")
    const project = join(root, "project")
    await mkdir(userHome, { recursive: true })
    await mkdir(join(project, ".wren"), { recursive: true })
    await writeFile(join(userHome, "config.json"), JSON.stringify(validConfig))
    await writeFile(
      join(project, ".wren", "config.json"),
      JSON.stringify({
        ...validConfig,
        defaultModel: { source: "test", model: "project-model" },
        sources: {
          test: {
            ...validConfig.sources.test,
            models: {
              ...validConfig.sources.test.models,
              "project-model": validConfig.sources.test.models["user-model"],
            },
          },
        },
      }),
    )
    setWrenConfigHomeForTests(userHome)

    try {
      expect(getConfigPaths()).toEqual([join(userHome, "config.json")])
      const result = await loadWrenConfig()
      expect(result.success).toBe(true)
      if (result.success)
        expect(result.config.defaultModel).toEqual({ source: "test", model: "user-model" })
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("retains an explicit config path for initialization and tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-explicit-"))
    const configPath = join(root, "explicit.json")
    await writeFile(configPath, JSON.stringify(validConfig))

    expect(getConfigPaths(configPath)).toEqual([configPath])
    const result = await loadWrenConfig(configPath)
    expect(result.success).toBe(true)
    if (result.success)
      expect(result.config.defaultModel).toEqual({ source: "test", model: "user-model" })
  })

  test("accepts theme and autoCompact preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-prefs-"))
    const configPath = join(root, "prefs.json")
    await writeFile(
      configPath,
      JSON.stringify({
        ...validConfig,
        theme: "light",
        autoCompact: false,
      }),
    )

    const result = await loadWrenConfig(configPath)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.config.theme).toBe("light")
      expect(result.config.autoCompact).toBe(false)
    }
  })

  test("accepts preferredLanguage preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-lang-"))
    const configPath = join(root, "lang.json")
    await writeFile(configPath, JSON.stringify({ ...validConfig, preferredLanguage: "zh" }))

    const result = await loadWrenConfig(configPath)

    expect(result.success).toBe(true)
    if (result.success) expect(result.config.preferredLanguage).toBe("zh")
  })

  test("rejects an invalid preferredLanguage", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-lang-bad-"))
    const configPath = join(root, "lang.json")
    await writeFile(configPath, JSON.stringify({ ...validConfig, preferredLanguage: "fr" }))

    const result = await loadWrenConfig(configPath)

    expect(result.success).toBe(false)
  })

  test("accepts same-named models from distinct sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-sources-"))
    const configPath = join(root, "sources.json")
    await writeFile(
      configPath,
      JSON.stringify({
        ...validConfig,
        sources: {
          first: {
            ...validConfig.sources.test,
            models: {
              "gpt-5.6-luna": {
                ...validConfig.sources.test.models["user-model"],
                supportsThinking: true,
                efforts: ["high"],
              },
            },
          },
          second: {
            ...validConfig.sources.test,
            models: {
              "gpt-5.6-luna": {
                ...validConfig.sources.test.models["user-model"],
                supportsThinking: true,
                efforts: ["high"],
              },
            },
          },
        },
        defaultModel: { source: "second", model: "gpt-5.6-luna", effort: "high" },
        smallFastModel: { source: "first", model: "gpt-5.6-luna" },
      }),
    )

    const result = await loadWrenConfig(configPath)

    expect(result.success).toBe(true)
  })

  test("rejects the removed aliases field", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-aliases-"))
    const configPath = join(root, "aliases.json")
    await writeFile(configPath, JSON.stringify({ ...validConfig, aliases: { fast: "user-model" } }))

    const result = await loadWrenConfig(configPath)

    expect(result.success).toBe(false)
  })

  test("patchWrenUserConfig writes a top-level patch to the user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-patch-"))
    const userHome = join(root, "user")
    await mkdir(userHome, { recursive: true })
    await writeFile(join(userHome, "config.json"), JSON.stringify(validConfig))
    setWrenConfigHomeForTests(userHome)

    try {
      const result = await patchWrenUserConfig({ preferredLanguage: "zh" })
      expect(result.success).toBe(true)
      if (result.success) expect(result.config.preferredLanguage).toBe("zh")

      const onDisk = JSON.parse(await readFile(join(userHome, "config.json"), "utf8"))
      expect(onDisk.preferredLanguage).toBe("zh")
      expect(onDisk.defaultModel).toEqual(validConfig.defaultModel)
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("patchWrenUserConfig fails without writing when no user config exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-patch-none-"))
    const userHome = join(root, "user")
    await mkdir(userHome, { recursive: true })
    setWrenConfigHomeForTests(userHome)

    try {
      const result = await patchWrenUserConfig({ preferredLanguage: "zh" })
      expect(result.success).toBe(false)
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("patchWrenUserConfig leaves the file untouched when the patch fails validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-patch-bad-"))
    const userHome = join(root, "user")
    await mkdir(userHome, { recursive: true })
    await writeFile(join(userHome, "config.json"), JSON.stringify(validConfig))
    setWrenConfigHomeForTests(userHome)

    try {
      const before = await readFile(join(userHome, "config.json"), "utf8")
      const result = await patchWrenUserConfig({ preferredLanguage: "fr" })
      expect(result.success).toBe(false)
      const after = await readFile(join(userHome, "config.json"), "utf8")
      expect(after).toBe(before)
    } finally {
      setWrenConfigHomeForTests(undefined)
    }
  })

  test("rejects legacy flat providers and models fields with actionable errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "wren-config-flat-models-"))
    const configPath = join(root, "flat-models.json")
    await writeFile(
      configPath,
      JSON.stringify({
        ...validConfig,
        providers: { legacy: { type: "openai-compatible-chat" } },
        models: { "legacy-model": { contextWindow: 128000 } },
      }),
    )

    const result = await loadWrenConfig(configPath)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain("Legacy config format detected")
      expect(result.error).toContain("sources")
      expect(result.error).toContain("providers")
      expect(result.error).toContain("models")
    }
  })
})

describe("Wren config lsp field", () => {
  async function loadWith(extra: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), "wren-config-lsp-"))
    const configPath = join(root, "config.json")
    await writeFile(configPath, JSON.stringify({ ...validConfig, ...extra }))
    return await loadWrenConfig(configPath)
  }

  test("accepts lsp: true (plugin LSP as usual)", async () => {
    const result = await loadWith({ lsp: true })
    expect(result.success).toBe(true)
    if (result.success) expect(result.config.lsp).toBe(true)
  })

  test("accepts lsp: false (disable all LSP)", async () => {
    const result = await loadWith({ lsp: false })
    expect(result.success).toBe(true)
    if (result.success) expect(result.config.lsp).toBe(false)
  })

  test("accepts a user-defined LSP server", async () => {
    const result = await loadWith({
      lsp: {
        typescript: {
          command: "typescript-language-server",
          args: ["--stdio"],
          extensionToLanguage: { ts: "typescript", tsx: "typescriptreact" },
          env: { NODE_OPTIONS: "--max-old-space-size=2048" },
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.config.lsp).toEqual({
        typescript: {
          command: "typescript-language-server",
          args: ["--stdio"],
          extensionToLanguage: { ts: "typescript", tsx: "typescriptreact" },
          env: { NODE_OPTIONS: "--max-old-space-size=2048" },
        },
      })
    }
  })

  test("rejects a command containing spaces", async () => {
    const result = await loadWith({
      lsp: {
        bad: { command: "my server --flag", extensionToLanguage: { x: "lang" } },
      },
    })
    expect(result.success).toBe(false)
  })

  test("rejects empty extensionToLanguage", async () => {
    const result = await loadWith({
      lsp: {
        bad: { command: "server", extensionToLanguage: {} },
      },
    })
    expect(result.success).toBe(false)
  })
})

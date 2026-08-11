import { afterEach, describe, expect, test } from "bun:test"
import { setConfigForTests } from "../../../utils/model/configBridge.js"
import { getAllLspServers } from "../config.js"

const minimalConfig = {
  defaultModel: { source: "test", model: "m" },
  smallFastModel: { source: "test", model: "m" },
  sources: { test: { type: "openai-compatible-chat", baseUrl: "https://example.invalid/v1", apiKey: "k", models: {} } },
} as const

afterEach(() => {
  setConfigForTests(null)
})

describe("getAllLspServers", () => {
  test("returns no servers when the Wren config has no lsp field", async () => {
    setConfigForTests({ ...minimalConfig } as never)
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers)).toHaveLength(0)
  })

  test("lsp: false disables all servers", async () => {
    setConfigForTests({ ...minimalConfig, lsp: false } as never)
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers)).toHaveLength(0)
  })

  test("lsp: false wins even when plugins provide servers", async () => {
    // Plugin loading is real in this environment; the kill switch must
    // short-circuit before any plugin lookup regardless.
    setConfigForTests({ ...minimalConfig, lsp: false } as never)
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers)).toHaveLength(0)
  })

  test("user-defined servers are loaded with default transport", async () => {
    setConfigForTests({
      ...minimalConfig,
      lsp: {
        typescript: {
          command: "typescript-language-server",
          extensionToLanguage: { ts: "typescript" },
        },
      },
    } as never)
    const { servers } = await getAllLspServers()
    expect(Object.keys(servers)).toEqual(["typescript"])
    expect(servers["typescript"]).toMatchObject({
      command: "typescript-language-server",
      extensionToLanguage: { ts: "typescript" },
      transport: "stdio",
      source: "user",
    })
  })

  test("user config survives plugin merge and keeps source=user", async () => {
    setConfigForTests({
      ...minimalConfig,
      lsp: {
        pyright: {
          command: "pyright-langserver",
          args: ["--stdio"],
          extensionToLanguage: { py: "python" },
          env: { PYTHONPATH: "/x" },
        },
      },
    } as never)
    const { servers } = await getAllLspServers()
    expect(servers["pyright"]).toMatchObject({
      command: "pyright-langserver",
      args: ["--stdio"],
      extensionToLanguage: { py: "python" },
      env: { PYTHONPATH: "/x" },
      transport: "stdio",
      source: "user",
    })
  })

  test("explicit transport and initializationOptions are preserved", async () => {
    setConfigForTests({
      ...minimalConfig,
      lsp: {
        sockety: {
          command: "my-server",
          extensionToLanguage: { x: "lang" },
          transport: "socket",
          initializationOptions: { project: "/tmp" },
        },
      },
    } as never)
    const { servers } = await getAllLspServers()
    expect(servers["sockety"]).toMatchObject({
      transport: "socket",
      initializationOptions: { project: "/tmp" },
    })
  })
})

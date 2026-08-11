import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const CLI_TEST_FILES = [
  "apps/cli/cli-pty.test.ts",
  "apps/cli/final-e2e.test.ts",
  "apps/cli/test-live-env.ts",
  "apps/cli/src/main.test.ts",
  "packages/adapter/src/local-adapter.test.ts",
] as const

const LIVE_SECRET_PATTERN = /OPENAI_API_KEY:\s*"sk-[^"]+"|OPENAI_API_KEY"]\s*=\s*"sk-[^"]+"/
const LEGACY_MODEL_PATTERN = /OPENAI_MODEL(?:"]|\s*:)\s*=??\s*"glm-5\.2"/

describe("Wren CLI test environment", () => {
  test("uses yoolc gpt-5.5 without literal live API keys", async () => {
    // Given: the focused CLI tests that launch or configure OpenAI-compatible mode.
    const files = await Promise.all(
      CLI_TEST_FILES.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
    )

    // When: their checked-in test environment literals are inspected.
    const filesWithLiveSecrets = files
      .filter((file) => LIVE_SECRET_PATTERN.test(file.text))
      .map((file) => file.path)
    const filesWithLegacyModels = files
      .filter((file) => LEGACY_MODEL_PATTERN.test(file.text))
      .map((file) => file.path)
    const filesWithYoolcModel = files
      .filter((file) => file.text.includes("gpt-5.5"))
      .map((file) => file.path)

    // Then: no test contains a live-looking key, legacy GLM model, or missing yoolc model migration.
    expect({ filesWithLiveSecrets, filesWithLegacyModels, filesWithYoolcModel }).toEqual({
      filesWithLiveSecrets: [],
      filesWithLegacyModels: [],
      filesWithYoolcModel: [...CLI_TEST_FILES],
    })
  })
})

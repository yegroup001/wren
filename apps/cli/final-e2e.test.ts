import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getLiveOpenAiEnv, LIVE_OPENAI_ENV_SKIP_REASON } from "./test-live-env"

const REPO_ROOT = new URL("../..", import.meta.url).pathname
const MAIN_ENTRY = "apps/cli/src/main.ts"
const PTY_TIMEOUT_MS = 60_000

const LIVE_OPENAI_ENV = getLiveOpenAiEnv()
const liveTest = LIVE_OPENAI_ENV === null ? test.skip : test
const LIVE_SUITE_NAME =
  LIVE_OPENAI_ENV === null
    ? `F3 final e2e: real CLI with gpt-5.5 provider (${LIVE_OPENAI_ENV_SKIP_REASON})`
    : "F3 final e2e: real CLI with gpt-5.5 provider"

type ProcessResult = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "wren-final-e2e-"))
}

async function runCli(args: readonly string[]): Promise<ProcessResult> {
  if (LIVE_OPENAI_ENV === null) {
    throw new Error(LIVE_OPENAI_ENV_SKIP_REASON)
  }

  const child = Bun.spawn([process.execPath, MAIN_ENTRY, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...LIVE_OPENAI_ENV },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe(LIVE_SUITE_NAME, () => {
  liveTest(
    "PROMPT: --prompt produces assistant output",
    async () => {
      const result = await runCli([await tempProject(), "--prompt", "Say hello in one word"])

      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBeGreaterThan(0)
      expect(result.stderr).not.toContain("Unhandled")
    },
    PTY_TIMEOUT_MS,
  )

  liveTest(
    "RESUME: --continue after a prompt resumes the previous session",
    async () => {
      const project = await tempProject()
      const first = await runCli([project, "--prompt", "Say hello"])
      expect(first.exitCode).toBe(0)

      const resumed = await runCli([project, "--continue", "--prompt", "What did I just ask?"])
      expect(resumed.exitCode).toBe(0)
      expect(resumed.stderr).not.toContain("Unhandled")
    },
    PTY_TIMEOUT_MS,
  )

  liveTest(
    "ERROR: invalid session exits with code 2 and a clear message",
    async () => {
      const result = await runCli([
        await tempProject(),
        "--session",
        "ses_nonexistent",
        "--prompt",
        "hello",
      ])

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("session not found: ses_nonexistent")
    },
    PTY_TIMEOUT_MS,
  )

  liveTest(
    "ERROR: --continue with no prior session exits with code 2",
    async () => {
      const result = await runCli([await tempProject(), "--continue", "--prompt", "hello"])

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("no previous session to continue")
    },
    PTY_TIMEOUT_MS,
  )
})

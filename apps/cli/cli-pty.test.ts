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
    ? `Wren CLI PTY smoke (${LIVE_OPENAI_ENV_SKIP_REASON})`
    : "Wren CLI PTY smoke"

type ProcessResult = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "wren-cli-pty-"))
}

async function runCliProcess(args: readonly string[]): Promise<ProcessResult> {
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
    "non-interactive --prompt returns assistant text from gpt-5.5",
    async () => {
      const result = await runCliProcess([await tempProject(), "--prompt", "Say hello in one word"])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain("Unhandled")
      expect(result.stderr).not.toContain("Cannot find")
      expect(result.stdout.length).toBeGreaterThan(0)
    },
    PTY_TIMEOUT_MS,
  )

  liveTest(
    "invalid --session exits with a clear usage error",
    async () => {
      const result = await runCliProcess([
        await tempProject(),
        "--session",
        "ses_missing",
        "--prompt",
        "hello",
      ])

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("session not found: ses_missing")
      expect(result.stderr).not.toContain("Unhandled")
    },
    PTY_TIMEOUT_MS,
  )

  liveTest(
    "--continue with no previous session exits with usage error",
    async () => {
      const result = await runCliProcess([await tempProject(), "--continue", "--prompt", "hello"])

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("no previous session to continue")
      expect(result.stderr).not.toContain("Unhandled")
    },
    PTY_TIMEOUT_MS,
  )

  liveTest(
    "--continue resumes a previous --prompt session",
    async () => {
      const project = await tempProject()
      const first = await runCliProcess([project, "--prompt", "Say hello in one word"])
      expect(first.exitCode).toBe(0)

      const resumed = await runCliProcess([
        project,
        "--continue",
        "--prompt",
        "What did I just ask?",
      ])
      expect(resumed.exitCode).toBe(0)
      expect(resumed.stderr).not.toContain("Unhandled")
    },
    PTY_TIMEOUT_MS,
  )
})

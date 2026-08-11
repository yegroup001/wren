import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = new URL("../..", import.meta.url).pathname
const PTY_TIMEOUT_MS = 120_000

const FAKE_ENV: Record<string, string> = {
  WREN_USE_OPENAI: "1",
  OPENAI_API_KEY: "test-key-not-real",
  OPENAI_BASE_URL: "https://example.invalid/v1",
  OPENAI_MODEL: "gpt-5.5",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
}

const ENABLED = process.env.WREN_QA_PACK_INSTALL === "1"
const packTest = ENABLED ? test : test.skip

type ProcessResult = {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

async function runCmd(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<ProcessResult> {
  const child = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("Todo 22: installed-package execution", () => {
  packTest(
    "npm pack produces a tarball with expected files",
    async () => {
      const result = await runCmd(["npm", "pack", "--dry-run", "--json"], { cwd: REPO_ROOT })

      expect(result.exitCode).toBe(0)
      const data = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>
      const files = data[0]?.files.map((f) => f.path) ?? []
      expect(files.some((f) => f.includes("apps/cli/src/main.ts"))).toBe(true)
      expect(files.some((f) => f.includes("packages/protocol/src/"))).toBe(true)
      expect(files.some((f) => f.includes("packages/config-node/src/"))).toBe(true)
      expect(files.some((f) => f.includes("packages/adapter/src/"))).toBe(true)
      expect(files.some((f) => f.includes("packages/tui/src/"))).toBe(true)
      expect(files.some((f) => f.includes("packages/engine/src/"))).toBe(true)
    },
    PTY_TIMEOUT_MS,
  )

  packTest(
    "npm pack excludes removed packages",
    async () => {
      const result = await runCmd(["npm", "pack", "--dry-run"], { cwd: REPO_ROOT })
      expect(result.stdout).not.toContain("computer-use-mcp")
      expect(result.stdout).not.toContain("audio-capture-napi")
      expect(result.stdout).not.toContain("doubaoime-asr")
    },
    PTY_TIMEOUT_MS,
  )

  packTest(
    "installed CLI starts and exits with usage error for unknown flag",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "wren-pack-"))
      try {
        const packResult = await runCmd(["npm", "pack"], { cwd: REPO_ROOT })
        expect(packResult.exitCode).toBe(0)
        const tarball = packResult.stdout.trim().split("\n").pop()?.trim()
        expect(tarball).toBeDefined()
        const tarballPath = join(REPO_ROOT, tarball ?? "")

        const installResult = await runCmd(["npm", "install", tarballPath], {
          cwd: tempDir,
          env: FAKE_ENV,
        })
        expect(installResult.exitCode).toBe(0)

        const cliResult = await runCmd(["npx", "wren", "--unknown-flag"], {
          cwd: tempDir,
          env: FAKE_ENV,
        })
        expect(cliResult.exitCode).toBe(2)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    },
    PTY_TIMEOUT_MS,
  )

  packTest(
    "installed CLI non-interactive mode sends prompt (fake env)",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "wren-pack-run-"))
      try {
        const projectDir = await mkdtemp(join(tempDir, "project-"))

        const packResult = await runCmd(["npm", "pack"], { cwd: REPO_ROOT })
        expect(packResult.exitCode).toBe(0)
        const tarball = packResult.stdout.trim().split("\n").pop()?.trim()
        expect(tarball).toBeDefined()
        const tarballPath = join(REPO_ROOT, tarball ?? "")

        const installResult = await runCmd(["npm", "install", tarballPath], {
          cwd: tempDir,
          env: FAKE_ENV,
        })
        expect(installResult.exitCode).toBe(0)

        const cliResult = await runCmd(["npx", "wren", projectDir, "--prompt", "hello"], {
          cwd: tempDir,
          env: FAKE_ENV,
        })

        expect(cliResult.exitCode).not.toBe(0)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    },
    PTY_TIMEOUT_MS,
  )
})

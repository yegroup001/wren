import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = new URL("../..", import.meta.url).pathname
const MAIN_ENTRY = "apps/cli/src/main.ts"
const PTY_TIMEOUT_MS = 30_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wren-pty-"))
  await mkdir(join(dir, ".wren"), { recursive: true })
  await mkdir(join(dir, ".config", "wren"), { recursive: true })
  await writeFile(
    join(dir, ".config", "wren", "config.json"),
    JSON.stringify({
      defaultModel: { source: "default", model: "gpt-5.5" },
      sources: {
        default: {
          type: "openai-compatible-chat",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key-not-real",
          models: {
            "gpt-5.5": { contextWindow: 128000, supportsThinking: false },
          },
        },
      },
    }),
  )
  return dir
}

async function runModelsCommand(cwd: string): Promise<string> {
  let output = ""
  const decoder = new TextDecoder()
  const waiters = new Map<string, Set<() => void>>()

  function resolveWaiters(): void {
    for (const [needle, callbacks] of waiters) {
      if (!output.includes(needle)) continue
      waiters.delete(needle)
      for (const resolve of callbacks) resolve()
    }
  }

  async function waitForTerminal(needle: string, timeoutMs: number): Promise<void> {
    if (output.includes(needle)) return
    await new Promise<void>((resolve, reject) => {
      const callbacks = waiters.get(needle) ?? new Set<() => void>()
      const complete = () => {
        clearTimeout(timeout)
        callbacks.delete(complete)
        if (callbacks.size === 0) waiters.delete(needle)
        resolve()
      }
      const timeout = setTimeout(() => {
        callbacks.delete(complete)
        if (callbacks.size === 0) waiters.delete(needle)
        reject(
          new Error(
            `terminal never rendered: ${needle}\noutput tail: ${JSON.stringify(output.slice(-2_000))}`,
          ),
        )
      }, timeoutMs)
      callbacks.add(complete)
      waiters.set(needle, callbacks)
      resolveWaiters()
    })
  }

  const child = Bun.spawn([process.execPath, MAIN_ENTRY, cwd], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      TERM: "xterm-256color",
    },
    terminal: {
      cols: 100,
      rows: 30,
      name: "xterm-256color",
      data: (_terminal, chunk) => {
        output += decoder.decode(chunk, { stream: true })
        resolveWaiters()
      },
    },
  })
  const terminal = child.terminal
  if (terminal === undefined) throw new Error("expected Bun terminal")
  const stderrPromise =
    child.stderr === null ? Promise.resolve("") : new Response(child.stderr).text()
  let failure: unknown
  let stderr = ""

  try {
    await waitForTerminal("Issue a local coding command", 8_000)
    await Bun.sleep(250)
    terminal.write("/models")
    await waitForTerminal("/models", 2_000)
    terminal.write("\r")
    try {
      await waitForTerminal("Select model", 2_000)
    } catch (slashError) {
      terminal.write("\x18m")
      try {
        await waitForTerminal("Select model", 2_000)
      } catch (leaderError) {
        throw new Error(
          `/models and <leader>m both failed to render the selector.\nslash: ${describeError(slashError)}\nleader: ${describeError(leaderError)}`,
        )
      }
      throw new Error(
        `/models did not open the selector, but <leader>m did.\nslash: ${describeError(slashError)}`,
      )
    }
  } catch (error) {
    failure = error
  } finally {
    child.kill("SIGTERM")
    await child.exited
    stderr = await stderrPromise
  }
  if (failure !== undefined) {
    const debugLines = output.match(/\[DEBUG[^\r\n]*/g) ?? []
    throw new Error(
      `${describeError(failure)}\nterminal debug: ${JSON.stringify(debugLines)}\nstderr: ${JSON.stringify(stderr)}`,
    )
  }
  return output
}

const enabled = process.env.WREN_QA_PTY === "1"
const ptyTest = enabled ? test : test.skip

describe("interactive model picker", () => {
  ptyTest(
    "/models opens the selector in a real terminal",
    async () => {
      // Given: a fresh local project and an interactive terminal process.
      const project = await tempProject()

      // When: the user enters the exact models command.
      const output = await runModelsCommand(project)

      // Then: the terminal renders the model selection dialog.
      expect(output).toContain("Select model")
    },
    PTY_TIMEOUT_MS,
  )
})

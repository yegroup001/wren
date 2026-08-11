import { renameSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"

type CompileResult = {
  readonly exitCode: number
  readonly stderr: string
}

type StagedCompiler = (stagedOutfile: string) => Promise<CompileResult>

type StagedCompilation = {
  readonly finalOutfile: string
  readonly compile: StagedCompiler
}

export class StandaloneCompileError extends Error {
  readonly name = "StandaloneCompileError"

  constructor(readonly stderr: string) {
    super(`Standalone binary compilation failed:\n${stderr}`)
  }
}

export class StagedOutputCleanupError extends Error {
  readonly name = "StagedOutputCleanupError"

  constructor(
    readonly compilationFailure: unknown,
    readonly cleanupFailure: unknown,
  ) {
    super("Standalone binary compilation failed and staged output cleanup also failed", {
      cause: cleanupFailure,
    })
  }
}

function stagedOutfileFor(finalOutfile: string): string {
  return join(dirname(finalOutfile), `.${basename(finalOutfile)}.${crypto.randomUUID()}.compile`)
}

function removeStagedOutfile(stagedOutfile: string, compilationFailure: unknown): void {
  try {
    rmSync(stagedOutfile, { force: true })
  } catch (cleanupFailure) {
    throw new StagedOutputCleanupError(compilationFailure, cleanupFailure)
  }
}

export async function compileStagedOutput({
  finalOutfile,
  compile,
}: StagedCompilation): Promise<void> {
  const stagedOutfile = stagedOutfileFor(finalOutfile)

  try {
    const result = await compile(stagedOutfile)
    if (result.exitCode !== 0) throw new StandaloneCompileError(result.stderr)
    renameSync(stagedOutfile, finalOutfile)
  } catch (error) {
    removeStagedOutfile(stagedOutfile, error)
    throw error
  }
}

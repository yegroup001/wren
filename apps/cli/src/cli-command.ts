import { Command } from "@commander-js/extra-typings"
import cliManifest from "../package.json" with { type: "json" }

export type CliOptions = {
  readonly auto?: boolean
  readonly continue?: true
  readonly model?: string
  readonly prompt?: string
  readonly session?: string
}

export type CliRunner = (project: string | undefined, options: CliOptions) => Promise<void>

export function createCliProgram(run: CliRunner) {
  return new Command()
    .name("wren")
    .description("Interactive coding agent")
    .version(cliManifest.version, "-v, --version", "Show the Wren version")
    .argument("[project]", "Project directory")
    .option("-m, --model <model>", "Override the configured model")
    .option("--prompt <text>", "Send one prompt without opening the TUI")
    .option("--continue", "Resume the most recent session")
    .option("--session <id>", "Resume a specific session")
    .option("--auto", "Automatically approve tool permissions (default)", true)
    .option("--no-auto", "Require manual approval for tool permissions")
    .showHelpAfterError()
    .action(run)
}

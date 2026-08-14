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

export type WebCliOptions = {
  readonly model?: string
  readonly port?: number
  readonly open: boolean
}

export type WebCliRunner = (project: string | undefined, options: WebCliOptions) => Promise<void>

export function createCliProgram(run: CliRunner, runWeb: WebCliRunner) {
  const program = new Command()
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

  program
    .command("web [project]")
    .description("Start the web GUI and open it in a browser")
    .option("--port <port>", "Port to listen on (default: a random free port)", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--no-open", "Do not open a browser automatically")
    .action((project, options) => {
      // `-m/--model` is registered on the root command only: commander parses
      // it into the parent's opts even when it appears after the subcommand
      // name (a duplicate flag on the subcommand would be shadowed), so read
      // it from the parent here.
      const model = program.opts().model
      return runWeb(project, model !== undefined ? { ...options, model } : options)
    })

  return program
}

import { describe, expect, test } from "bun:test"
import { type CliOptions, createCliProgram, type WebCliOptions } from "./cli-command"

describe("CLI command", () => {
  test("uses auto permission mode by default", async () => {
    let invocation:
      | { readonly project: string | undefined; readonly options: CliOptions }
      | undefined
    const program = createCliProgram(
      async (project, options) => {
        invocation = { project, options }
      },
      async () => {},
    )

    await program.parseAsync(["project", "--prompt", "hello"], { from: "user" })

    expect(invocation).toEqual({
      project: "project",
      options: {
        auto: true,
        prompt: "hello",
      },
    })
  })

  test("--no-auto disables auto permission mode", async () => {
    let invocation:
      | { readonly project: string | undefined; readonly options: CliOptions }
      | undefined
    const program = createCliProgram(
      async (project, options) => {
        invocation = { project, options }
      },
      async () => {},
    )

    await program.parseAsync(["project", "--no-auto", "--prompt", "hello"], { from: "user" })

    expect(invocation).toEqual({
      project: "project",
      options: {
        auto: false,
        prompt: "hello",
      },
    })
  })

  test("web subcommand does not consume the root project argument", async () => {
    let rootInvocation:
      | { readonly project: string | undefined; readonly options: CliOptions }
      | undefined
    let webInvocation:
      | { readonly project: string | undefined; readonly options: WebCliOptions }
      | undefined
    const program = createCliProgram(
      async (project, options) => {
        rootInvocation = { project, options }
      },
      async (project, options) => {
        webInvocation = { project, options }
      },
    )

    await program.parseAsync(["web"], { from: "user" })

    expect(rootInvocation).toBeUndefined()
    expect(webInvocation).toEqual({ project: undefined, options: { open: true } })
  })

  test("web subcommand parses --port and --no-open", async () => {
    let invocation:
      | { readonly project: string | undefined; readonly options: WebCliOptions }
      | undefined
    const program = createCliProgram(
      async () => {},
      async (project, options) => {
        invocation = { project, options }
      },
    )

    await program.parseAsync(["web", "project", "--port", "8080", "--no-open", "-m", "gpt-5.5"], {
      from: "user",
    })

    expect(invocation).toEqual({
      project: "project",
      options: { port: 8080, open: false, model: "gpt-5.5" },
    })
  })

  test("root command still parses a project that looks like a path", async () => {
    let invocation:
      | { readonly project: string | undefined; readonly options: CliOptions }
      | undefined
    const program = createCliProgram(
      async (project, options) => {
        invocation = { project, options }
      },
      async () => {},
    )

    await program.parseAsync(["/tmp/project", "--prompt", "hi"], { from: "user" })

    expect(invocation).toEqual({ project: "/tmp/project", options: { auto: true, prompt: "hi" } })
  })
})

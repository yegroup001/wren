import { describe, expect, test } from "bun:test"
import { type CliOptions, createCliProgram } from "./cli-command"

describe("CLI command", () => {
  test("uses auto permission mode by default", async () => {
    let invocation:
      | { readonly project: string | undefined; readonly options: CliOptions }
      | undefined
    const program = createCliProgram(async (project, options) => {
      invocation = { project, options }
    })

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
    const program = createCliProgram(async (project, options) => {
      invocation = { project, options }
    })

    await program.parseAsync(["project", "--no-auto", "--prompt", "hello"], { from: "user" })

    expect(invocation).toEqual({
      project: "project",
      options: {
        auto: false,
        prompt: "hello",
      },
    })
  })
})

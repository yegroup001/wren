import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Status } from "@wren/protocol"
import type { JSX } from "solid-js"
import { ThemeProvider } from "../context/theme"
import { PromptShell } from "./prompt-shell"

function ShellHarness(props: {
  readonly showHints?: boolean
  readonly status?: Status
}): JSX.Element {
  return (
    <PromptShell
      cwd="test"
      model="test-model"
      variant="default"
      permissionMode="default"
      pasteSummary={undefined}
      status={props.status ?? { type: "idle" }}
      interruptCount={0}
      showHints={props.showHints}
    >
      <text>input area</text>
    </PromptShell>
  )
}

describe("prompt-shell", () => {
  test("renders model name and status", async () => {
    const setup = await testRender(
      () => (
        <ThemeProvider>
          <ShellHarness />
        </ThemeProvider>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    expect(frame).toContain("test-model")
    expect(frame).toContain("ready")

    setup.renderer.destroy()
  })

  test("renders compacting and retry statuses", async () => {
    for (const [status, label] of [
      [{ type: "compacting" }, "compacting"],
      [{ type: "retry", attempt: 1, maxRetries: 3 }, "retry 1/3"],
    ] as const) {
      const setup = await testRender(
        () => (
          <ThemeProvider>
            <ShellHarness status={status} />
          </ThemeProvider>
        ),
        { width: 80, height: 24 },
      )

      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(label)
      setup.renderer.destroy()
    }
  })

  test("hides input hints while a modal owns interaction", async () => {
    const setup = await testRender(
      () => (
        <ThemeProvider>
          <ShellHarness showHints={false} />
        </ThemeProvider>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    expect(frame).not.toContain("Enter send")
    expect(frame).not.toContain("Shift+Enter line")
    setup.renderer.destroy()
  })
})

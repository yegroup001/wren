import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { type JSX, onMount } from "solid-js"
import { DialogProvider, useDialog } from "../context/dialog"
import { ThemeProvider } from "../context/theme"
import { KeymapProvider, useBindings } from "../keymap"
import { DialogHost } from "./dialog"

let exitCalled = false

function AppHarness(): JSX.Element {
  useBindings(() => ({
    bindings: [
      {
        key: "ctrl+c",
        desc: "Exit",
        group: "App",
        cmd: () => {
          exitCalled = true
        },
      },
    ],
  }))

  const dialog = useDialog()
  onMount(() => {
    void dialog.alert("Test", "Test message")
  })

  return <DialogHost />
}

describe("dialog key event leakage", () => {
  test("ctrl+c does not trigger app exit handler when dialog is open", async () => {
    exitCalled = false

    const setup = await testRender(
      () => (
        <ThemeProvider>
          <DialogProvider>
            <KeymapProvider>
              <AppHarness />
            </KeymapProvider>
          </DialogProvider>
        </ThemeProvider>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    await setup.flush()

    setup.mockInput.pressCtrlC()
    await setup.flush()

    expect(exitCalled).toBe(false)

    setup.renderer.destroy()
  })
})

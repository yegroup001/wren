import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, type JSX, onMount, Show } from "solid-js"
import { type DialogEntry, DialogProvider, useDialog } from "../context/dialog"
import { ThemeProvider } from "../context/theme"
import { DialogPrompt } from "./dialog-prompt"

function PromptHarness(props: {
  onPromise: (p: Promise<string | undefined>) => void
}): JSX.Element {
  const dialog = useDialog()
  const [entry, setEntry] = createSignal<DialogEntry | undefined>(undefined)

  onMount(() => {
    const promise = dialog.prompt("Test", { description: "Enter text" })
    props.onPromise(promise)
    const stack = dialog.stack()
    const top = stack[stack.length - 1]
    if (top !== undefined) {
      setEntry(top)
    }
  })

  return <Show when={entry()}>{(e) => <DialogPrompt entry={e()} />}</Show>
}

describe("dialog-prompt", () => {
  test("cancelling with escape resolves to undefined, not null", async () => {
    let capturedPromise: Promise<string | undefined> | undefined

    const setup = await testRender(
      () => (
        <ThemeProvider>
          <DialogProvider>
            <PromptHarness
              onPromise={(p) => {
                capturedPromise = p
              }}
            />
          </DialogProvider>
        </ThemeProvider>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    await setup.flush()

    setup.mockInput.pressEscape()
    await setup.flush()

    expect(capturedPromise).toBeDefined()
    const result = await capturedPromise
    expect(result).toBeUndefined()

    setup.renderer.destroy()
  })
})

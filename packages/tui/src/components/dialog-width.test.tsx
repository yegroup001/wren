import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createTuiStore, type WrenAdapter } from "@wren/adapter"
import { parseSessionId } from "@wren/protocol"
import type { JSX, ParentProps } from "solid-js"
import { DialogProvider } from "../context/dialog"
import { LocalProvider } from "../context/local"
import { RouteProvider } from "../context/route"
import { StoreProvider } from "../context/store"
import { ThemeProvider } from "../context/theme"
import { KeymapProvider } from "../keymap"
import { ToastProvider } from "../ui/toast"
import { DialogModel } from "./dialog-model"
import { DialogSessionList } from "./dialog-session-list"

const SESSION_ID = parseSessionId("ses_dialog_width")

function createAdapter(): WrenAdapter {
  const state = createTuiStore()
  state.addSession({
    id: SESSION_ID,
    cwd: "/tmp/project",
    modelId: "source/model",
    permissionMode: "default",
  })
  return {
    state,
    async fetch(): Promise<Response> {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    async resume(): Promise<void> {},
    async waitForIdle(): Promise<void> {},
  }
}

function TestProviders(props: ParentProps<{ adapter: WrenAdapter }>): JSX.Element {
  return (
    <RouteProvider>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider initialCwd="/tmp/project" initialModel="source/model">
            <DialogProvider>
              <ToastProvider>
                <KeymapProvider>{props.children}</KeymapProvider>
              </ToastProvider>
            </DialogProvider>
          </LocalProvider>
        </ThemeProvider>
      </StoreProvider>
    </RouteProvider>
  )
}

describe("dialog width at 80 columns", () => {
  test("keeps the model footer on one line", async () => {
    const setup = await testRender(
      () => (
        <TestProviders adapter={createAdapter()}>
          <DialogModel visible={() => true} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 40 },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("enter select · type filter/custom · ←/→ scope · esc")
    setup.renderer.destroy()
  })

  test("keeps the session footer on one line", async () => {
    const setup = await testRender(
      () => (
        <TestProviders adapter={createAdapter()}>
          <DialogSessionList visible={() => true} onClose={() => {}} />
        </TestProviders>
      ),
      { width: 80, height: 24 },
    )

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("enter resume · r rename · d delete · esc")
    setup.renderer.destroy()
  })
})

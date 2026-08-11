import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"

describe("overlay layout probe", () => {
  test("absolute overlay in flexGrow container", async () => {
    const [visible, setVisible] = createSignal(true)
    const setup = await testRender(
      () => (
        <box flexGrow={1}>
          <text>HOME-CONTENT</text>
          <Show when={visible()}>
            <box
              position="absolute"
              zIndex={3000}
              left={0}
              top={0}
              width={40}
              height={10}
              alignItems="center"
              paddingTop={2}
              backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
            >
              <box width={20} border backgroundColor="#ffffff">
                <text>DIALOG</text>
              </box>
            </box>
          </Show>
        </box>
      ),
      { width: 40, height: 10 },
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    console.log("FRAME:", JSON.stringify(frame))
    setup.renderer.destroy()
  })
})

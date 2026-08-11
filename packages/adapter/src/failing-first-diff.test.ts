import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@wren/engine"
import { parseSessionId } from "@wren/protocol"
import { createRoot } from "solid-js"
import { consumeSDKMessageStream } from "./message-mapper"
import { createTuiStore } from "./store"

// ---------------------------------------------------------------------------
// Failing-first test for fake diff generation.
// The adapter records only {path, added:0, removed:0} for edit/write tools,
// and the TUI fabricates "+added line N" / "-removed line N" patch text.
// After Wave 2 fix, the mapper should extract real patch content from
// tool_use_result structuredPatch, and the TUI should render it.
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-07-11T00:00:00.000Z"

describe("failing-first: fake diff generation", () => {
  test("adapter should extract real patch content from Edit tool_result, not fabricate", async () => {
    const sessionId = parseSessionId("ses_diff_test")
    createRoot((dispose) => {
      const store = createTuiStore()
      store.addSession({
        id: sessionId,
        cwd: "/tmp/project",
        modelId: "fake/model",
        permissionMode: "default",
      })

      const toolUseId = "tu_edit_1"

      const assistantWithEdit: SDKMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_edit",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: "Edit",
              input: {
                file_path: "/tmp/project/src/app.ts",
                old_string: "const x = 1",
                new_string: "const x = 2",
                replace_all: false,
              },
            },
          ],
        },
        uuid: "u1",
      } as SDKMessage

      // Real tool_result: mapToolResultToToolResultBlockParam converts the
      // tool's structured output to a plain-text summary, so the adapter
      // never sees structuredPatch in the result content. Diff stats must be
      // recomputed from the tool_use input (old_string/new_string).
      const userWithToolResult: SDKMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: "The file /tmp/project/src/app.ts has been updated successfully.",
            },
          ],
        },
        uuid: "u2",
      } as SDKMessage

      const result: SDKMessage = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: "end_turn",
        session_id: "ses_diff_test",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        result: "",
      } as SDKMessage

      async function* stream(): AsyncGenerator<SDKMessage, void, unknown> {
        yield {
          type: "system",
          subtype: "init",
          cwd: "/tmp",
          session_id: "ses_diff_test",
          tools: [],
          model: "fake/model",
          permissionMode: "default",
          uuid: "u0",
        } as SDKMessage
        yield assistantWithEdit
        yield userWithToolResult
        yield result
      }

      consumeSDKMessageStream(stream(), {
        clock: { now: () => FIXED_NOW },
        sessionId,
        store,
      }).then(() => {
        const bundle = store.getBundle(sessionId)
        const diff = bundle?.diff

        expect(diff).toBeDefined()
        expect(diff?.length).toBeGreaterThan(0)

        const fileDiff = diff?.[0]
        expect(fileDiff).toBeDefined()

        expect(fileDiff?.path).toContain("app.ts")
        expect(fileDiff?.added).toBe(1)
        expect(fileDiff?.removed).toBe(1)

        dispose()
      })
    })
  })

  test("diff-viewer-parts generatePatch should not produce 'added line N' text", () => {
    // BUG: diff-viewer-parts.tsx:110-123 fabricates patch text as
    // "+added line 1", "-removed line 1" etc. when no real patch exists.
    // After fix: generatePatch should be deleted; the viewer should render
    // real patch content from the store, or show "No patch available".

    // Verify the fake generation function exists and produces fake text
    const fs = require("node:fs")
    const path = require("node:path")
    const source = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "tui", "src", "components", "diff-viewer-parts.tsx"),
      "utf8",
    )

    // The fake function exists
    expect(source).toContain("generatePatch")
    expect(source).not.toContain("added line")
    expect(source).not.toContain("removed line")

    // After fix: generatePatch should be removed and the viewer should
    // render real patch hunks from the SnapshotFileDiff.patch field.
  })
})

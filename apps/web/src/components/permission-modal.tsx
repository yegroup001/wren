import type { PermissionRequest } from "@wren/protocol"
import { createSignal, Show } from "solid-js"
import { api } from "../api"
import { renderMarkdown } from "../utils/markdown"

function describeInput(input: unknown): string {
  if (typeof input === "string") return input
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  const record = input as Record<string, unknown>
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n")
}

export function PermissionModal(props: {
  readonly sessionId: string
  readonly request: PermissionRequest
}) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  async function respond(response: "once" | "session" | "deny"): Promise<void> {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.respondPermission(props.sessionId, props.request.id, response)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">Tool permission</span>
          <span class="permission-tool">{props.request.toolName}</span>
        </div>
        <div class="modal-body">
          <div class="permission-detail">
            <Show
              when={
                props.request.displayType === "bash" ||
                props.request.displayType === "edit" ||
                props.request.displayType === "read" ||
                props.request.displayType === "write" ||
                props.request.displayType === "mcp"
              }
            >
              <pre class="json-block">{describeInput(props.request.input)}</pre>
            </Show>
            <Show
              when={
                props.request.displayType !== "bash" &&
                props.request.displayType !== "edit" &&
                props.request.displayType !== "read" &&
                props.request.displayType !== "write" &&
                props.request.displayType !== "mcp"
              }
            >
              <div
                class="markdown"
                innerHTML={renderMarkdown(describeInput(props.request.input))}
              />
            </Show>
          </div>
          <Show when={error() !== undefined}>
            <div class="prompt-error">{error()}</div>
          </Show>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" disabled={busy()} onClick={() => void respond("once")}>
            Allow once
          </button>
          <button
            type="button"
            class="btn"
            disabled={busy()}
            onClick={() => void respond("session")}
          >
            Allow session
          </button>
          <button
            type="button"
            class="btn danger"
            disabled={busy()}
            onClick={() => void respond("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}

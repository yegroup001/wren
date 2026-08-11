/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js"
import { SubagentTranscriptView } from "../components/subagent-transcript-view"
import { useRoute } from "../context/route"
import { useAdapter } from "../context/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { Spinner } from "../ui/spinner"

export function SubagentRoute(props: {
  sessionId: string
  agentId: string
  description: string
  agentStatus: "running" | "pending" | "completed" | "failed"
}): JSX.Element {
  const adapter = useAdapter()
  const { back } = useRoute()
  const { theme } = useTheme()

  const [messages, setMessages] = createSignal<unknown[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | undefined>()

  const goBack = (): void => {
    back()
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      goBack()
    }
  })

  useBindings(() => ({
    bindings: [
      { key: "<leader>backspace", desc: "Back to session", group: "Subagent", cmd: goBack },
    ],
  }))

  createEffect(() => {
    const sessionId = props.sessionId
    const agentId = props.agentId
    const controller = new AbortController()
    setMessages([])
    setError(undefined)
    setLoading(true)

    void (async () => {
      try {
        const res = await adapter.fetch(
          createWrenRequest(`/session/${sessionId}/subagent/${agentId}`, {
            method: "GET",
            signal: controller.signal,
          }),
        )
        if (res.ok) {
          const data = (await res.json()) as { messages?: unknown[] }
          setMessages(Array.isArray(data.messages) ? data.messages : [])
        } else {
          let detail =
            res.status === 404
              ? "Subagent transcript not found"
              : res.status === 501
                ? "Subagent transcripts are unavailable"
                : `Failed to load transcript (${res.status})`
          try {
            const body = (await res.json()) as { message?: string; error?: string }
            detail = body.message ?? body.error ?? detail
          } catch {
            // ignore parse error
          }
          setError(detail)
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : "fetch failed")
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()

    onCleanup(() => {
      controller.abort()
    })
  })

  onCleanup(() => setLoading(false))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
        border
        borderStyle="single"
        borderColor={theme().border}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme().backgroundElement}
      >
        <box flexDirection="row" gap={1}>
          <text
            fg={theme().accent}
            attributes={TextAttributes.BOLD}
            flexShrink={0}
            onMouseUp={goBack}
          >
            {"\u2190 Back"}
          </text>
          <text fg={theme().textMuted}>{"│"}</text>
          <text fg={theme().primary} wrapMode="none" attributes={TextAttributes.BOLD}>
            {props.description}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <Show when={!loading()}>
            <text fg={theme().textMuted} wrapMode="none">{`${messages().length} messages`}</text>
          </Show>
          <Show when={props.agentStatus === "running" || props.agentStatus === "pending"}>
            <Spinner style="dots" color={theme().info} />
          </Show>
          <Show when={props.agentStatus === "completed"}>
            <text fg={theme().success} wrapMode="none">{"\u25cf done"}</text>
          </Show>
          <Show when={props.agentStatus === "failed"}>
            <text fg={theme().error} wrapMode="none">{"\u25cf failed"}</text>
          </Show>
          <text fg={theme().textMuted} wrapMode="none">{"esc to go back"}</text>
        </box>
      </box>
      <box
        flexGrow={1}
        minHeight={0}
        border
        borderStyle="single"
        borderColor={theme().border}
        overflow="hidden"
      >
        <Show
          when={!loading()}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} paddingTop={1}>
              <Spinner style="dots" color={theme().info} />
              <text fg={theme().textMuted}>{"Loading subagent transcript..."}</text>
            </box>
          }
        >
          <Show
            when={messages().length > 0}
            fallback={
              <text fg={error() !== undefined ? theme().error : theme().textMuted} paddingLeft={3}>
                {error() !== undefined ? `Error: ${error()}` : "No transcript available"}
              </text>
            }
          >
            <SubagentTranscriptView
              messages={messages()}
              sessionId={props.sessionId}
              agentActive={props.agentStatus === "running" || props.agentStatus === "pending"}
            />
          </Show>
        </Show>
      </box>
      <box flexShrink={0} paddingLeft={1}>
        <text fg={theme().textMuted} wrapMode="none">
          {"esc back \u00b7 ctrl+u/d scroll \u00b7 ctrl+g top"}
        </text>
      </box>
    </box>
  )
}

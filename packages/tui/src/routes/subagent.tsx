/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js"
import { SubagentTranscriptView } from "../components/subagent-transcript-view"
import { useRoute } from "../context/route"
import { useAdapter } from "../context/store"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { Spinner } from "../ui/spinner"

interface UsageBlock {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface SubagentMessage {
  type: string
  message?: {
    role?: string
    model?: string
    usage?: UsageBlock
    content?: Array<Record<string, unknown>> | string
  }
  uuid: string
  timestamp?: string
}

function formatTokens(total: number): string {
  if (total === 0) return ""
  if (total < 1000) return `${total} tok`
  return `${(total / 1000).toFixed(1)}k tok`
}

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

  const tokenTotal = createMemo((): number => {
    let sum = 0
    for (const raw of messages()) {
      const msg = raw as SubagentMessage | undefined
      const usage = msg?.message?.usage
      if (usage === undefined) continue
      sum +=
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
    }
    return sum
  })

  const tokenText = createMemo((): string => formatTokens(tokenTotal()))

  const modelName = createMemo((): string | undefined => {
    for (const raw of messages()) {
      const model = (raw as SubagentMessage | undefined)?.message?.model
      if (typeof model === "string" && model !== "") return model
    }
    return undefined
  })

  const todoSummary = createMemo((): { completed: number; total: number } | undefined => {
    let latest: { completed: number; total: number } | undefined
    for (const raw of messages()) {
      const content = (raw as SubagentMessage | undefined)?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== "tool_use") continue
        const name = (block as { name?: string }).name?.toLowerCase()
        if (name !== "todowrite" && name !== "todowritetool") continue
        const todos = (block as { input?: { todos?: unknown[] } }).input?.todos
        if (!Array.isArray(todos)) continue
        const total = todos.length
        const completed = todos.filter(
          (t) => (t as { status?: string })?.status === "completed",
        ).length
        latest = { completed, total }
      }
    }
    return latest
  })

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
          <Show when={!loading() && modelName() !== undefined}>
            <text fg={theme().textMuted} wrapMode="none">{`\u00b7 ${modelName()}`}</text>
          </Show>
          <Show when={!loading() && tokenText() !== ""}>
            <text fg={theme().textMuted} wrapMode="none">{`\u00b7 ${tokenText()}`}</text>
          </Show>
          <Show when={!loading() && todoSummary() !== undefined}>
            <text fg={theme().textMuted} wrapMode="none">
              {`\u00b7 ${todoSummary()?.completed ?? 0}/${todoSummary()?.total ?? 0} todos`}
            </text>
          </Show>
          <Show when={props.agentStatus === "running" || props.agentStatus === "pending"}>
            <Spinner style="dots" color={theme().info} />
          </Show>
          <Show when={props.agentStatus === "completed"}>
            <text fg={theme().success} wrapMode="none">
              {"\u25cf done"}
            </text>
          </Show>
          <Show when={props.agentStatus === "failed"}>
            <text fg={theme().error} wrapMode="none">
              {"\u25cf failed"}
            </text>
          </Show>
          <text fg={theme().textMuted} wrapMode="none">
            {"esc to go back"}
          </text>
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

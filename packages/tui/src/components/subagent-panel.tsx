/** @jsxImportSource @opentui/solid */

import type { Message, SessionId, ToolStatusType } from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { useRoute } from "../context/route"
import { useStore } from "../context/store"
import { useTheme } from "../context/theme"

interface SubagentEntry {
  partId: string
  status: ToolStatusType
  description: string
  agentType: string
  agentId?: string
  durationMs?: number
  startedAt: string
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function extractAgentId(output: unknown): string | undefined {
  if (typeof output === "string") {
    const match = output.match(/agentId:\s*(\S+)/)
    return match?.[1]
  }
  if (Array.isArray(output)) {
    for (const block of output) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        const text = (block as Record<string, unknown>).text
        if (typeof text === "string") {
          const match = text.match(/agentId:\s*(\S+)/)
          if (match?.[1]) return match[1]
        }
      }
    }
  }
  return undefined
}

function extractDurationMs(output: unknown): number | undefined {
  const text =
    typeof output === "string"
      ? output
      : Array.isArray(output)
        ? output
            .filter(
              (b): b is Record<string, unknown> =>
                typeof b === "object" && b !== null && b.type === "text",
            )
            .map((b) => b.text)
            .filter((t): t is string => typeof t === "string")
            .join("\n")
        : ""
  if (text === "") return undefined
  const match = text.match(/duration_ms:\s*(\d+)/)
  return match?.[1] !== undefined ? parseInt(match[1], 10) : undefined
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}m${rem}s`
}

function isWorking(status: ToolStatusType): boolean {
  return status === "running" || status === "pending"
}

export function SubagentPanel(props: { sessionId: string }): JSX.Element {
  const store = useStore()
  const { theme } = useTheme()
  const { navigate } = useRoute()

  const messages = createMemo<Message[]>(() => store.store.messages[props.sessionId] ?? [])

  const subagents = createMemo<SubagentEntry[]>(() => {
    const result: SubagentEntry[] = []
    for (const msg of messages()) {
      for (const part of msg.parts) {
        if (part.type !== "tool_use") continue
        if (part.toolName.toLowerCase() !== "agent") continue
        const input = recordValue(part.input)
        result.push({
          partId: part.id,
          status: part.status,
          description: stringValue(input?.description) ?? stringValue(input?.prompt) ?? "Agent",
          agentType: stringValue(input?.subagent_type) ?? "general-purpose",
          agentId: part.agentId ?? extractAgentId(part.output),
          durationMs: extractDurationMs(part.output),
          startedAt: msg.createdAt,
        })
      }
    }
    return result
  })

  const workingAgents = createMemo(() => subagents().filter((s) => isWorking(s.status)))
  const retiredAgents = createMemo(() =>
    subagents()
      .filter((s) => !isWorking(s.status))
      .reverse(),
  )

  const hasRunning = createMemo(() => subagents().some((s) => s.status === "running"))

  // Tick every second to update running durations — only active when something is running
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  const update = (): void => {
    if (hasRunning()) {
      if (timer === undefined) {
        timer = setInterval(() => setNow(Date.now()), 1000)
      }
    } else {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
  }
  createEffect(() => {
    hasRunning()
    update()
  })

  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  const onEntryClick = (entry: SubagentEntry): void => {
    if (entry.status === "pending" || entry.agentId === undefined) return
    navigate({
      type: "subagent",
      sessionId: props.sessionId as SessionId,
      agentId: entry.agentId,
      description: entry.description,
      agentStatus: entry.status,
    })
  }

  const statusIcon = (status: ToolStatusType): string => {
    if (status === "running") return "\u25b6"
    if (status === "completed") return "\u2713"
    if (status === "failed") return "\u2717"
    return "\u25cb"
  }

  const statusColor = (status: ToolStatusType): string => {
    if (status === "running") return theme().warning
    if (status === "completed") return theme().success
    if (status === "failed") return theme().error
    return theme().textMuted
  }

  const durationLabel = (entry: SubagentEntry): string => {
    if (entry.status === "completed" && entry.durationMs !== undefined) {
      return formatDuration(entry.durationMs)
    }
    if (entry.status === "running") {
      const elapsed = now() - new Date(entry.startedAt).getTime()
      return elapsed > 0 ? `${formatDuration(elapsed)}` : "..."
    }
    return ""
  }

  const renderEntry = (entry: SubagentEntry, _idx: number): JSX.Element => (
    <box flexDirection="column" paddingBottom={1} onMouseUp={() => onEntryClick(entry)}>
      <box flexDirection="row" gap={1}>
        <text fg={statusColor(entry.status)} flexShrink={0}>
          {statusIcon(entry.status)}
        </text>
        <text fg={theme().toolAgent} flexShrink={0}>
          {entry.agentType}
        </text>
        <text fg={theme().textMuted} flexGrow={1} wrapMode="none">
          {durationLabel(entry) !== "" ? durationLabel(entry) : ""}
        </text>
      </box>
      <text fg={theme().text} wrapMode="none">
        {entry.description}
      </text>
    </box>
  )

  return (
    <Show when={subagents().length > 0} fallback={<text fg={theme().textMuted}>No subagents</text>}>
      <SubagentGroup
        label="Working"
        entries={workingAgents()}
        renderEntry={renderEntry}
        defaultExpanded={true}
      />
      <SubagentGroup
        label="Retired"
        entries={retiredAgents()}
        renderEntry={renderEntry}
        defaultExpanded={true}
      />
    </Show>
  )
}

function SubagentGroup(props: {
  label: string
  entries: readonly SubagentEntry[]
  renderEntry: (entry: SubagentEntry, idx: number) => JSX.Element
  defaultExpanded: boolean
}): JSX.Element {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(props.defaultExpanded)

  return (
    <Show when={props.entries.length > 0}>
      <box flexDirection="column" paddingBottom={1}>
        <box flexDirection="row" gap={1} onMouseUp={() => setExpanded((prev) => !prev)}>
          <text fg={theme().textMuted} flexShrink={0}>
            {expanded() ? "\u25be" : "\u25b8"}
          </text>
          <text fg={theme().textMuted} flexShrink={0}>
            {`${props.label} (${props.entries.length})`}
          </text>
        </box>
        <Show when={expanded()}>
          <box flexDirection="column" paddingLeft={1} paddingTop={1}>
            <For each={props.entries}>{(entry, idx) => props.renderEntry(entry, idx())}</For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

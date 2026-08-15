import type { ToolStatusType } from "@wren/protocol"
import { For, Show } from "solid-js"
import type { SubagentInfo } from "../utils/subagent"
import { splitSubagentGroups } from "../utils/subagent"

const STATUS_ICON: Record<ToolStatusType, string> = {
  running: "▶",
  pending: "○",
  completed: "✓",
  failed: "✗",
}

function statusClass(status: ToolStatusType): string {
  return `subagent-status ${status}`
}

export function SubagentPanel(props: {
  readonly sessionId: string
  readonly agents: readonly SubagentInfo[]
  readonly onOpen: (agentId: string) => void
}) {
  const groups = () => splitSubagentGroups(props.agents)

  return (
    <div class="subagent-panel">
      <Show when={props.agents.length === 0}>
        <div class="sidebar-empty">No subagents spawned</div>
      </Show>
      <Show when={groups().working.length > 0}>
        <div class="subagent-group-label">Working ({groups().working.length})</div>
        <For each={groups().working}>
          {(agent) => <SubagentRow agent={agent} onOpen={props.onOpen} />}
        </For>
      </Show>
      <Show when={groups().retired.length > 0}>
        <div class="subagent-group-label">Retired ({groups().retired.length})</div>
        <For each={groups().retired}>
          {(agent) => <SubagentRow agent={agent} onOpen={props.onOpen} />}
        </For>
      </Show>
    </div>
  )
}

function SubagentRow(props: { agent: SubagentInfo; onOpen: (id: string) => void }) {
  const clickable = () => props.agent.agentId !== undefined && props.agent.status !== "pending"
  return (
    <button
      type="button"
      class="subagent-row"
      disabled={!clickable()}
      onClick={() => clickable() && props.agent.agentId !== undefined && props.onOpen(props.agent.agentId)}
    >
      <span class={statusClass(props.agent.status)}>{STATUS_ICON[props.agent.status]}</span>
      <span class="subagent-id">{props.agent.agentType}</span>
      <span class="subagent-desc">{props.agent.label}</span>
      <span class="subagent-open">→</span>
    </button>
  )
}

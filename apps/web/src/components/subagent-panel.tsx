import { For, Show } from "solid-js"

export function SubagentPanel(props: {
  readonly sessionId: string
  readonly agents: readonly string[]
  readonly onOpen: (agentId: string) => void
}) {
  return (
    <div class="subagent-panel">
      <Show when={props.agents.length === 0}>
        <div class="sidebar-empty">No subagents spawned</div>
      </Show>
      <For each={props.agents}>
        {(agentId) => (
          <button type="button" class="subagent-row" onClick={() => props.onOpen(agentId)}>
            <span class="subagent-id">{agentId}</span>
            <span class="subagent-open">open →</span>
          </button>
        )}
      </For>
    </div>
  )
}

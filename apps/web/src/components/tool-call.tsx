import type { Part } from "@wren/protocol"
import { createSignal, Show } from "solid-js"

function PrettyJson(props: { readonly value: unknown }) {
  return <pre class="json-block">{JSON.stringify(props.value, null, 2)}</pre>
}

function ToolOutput(props: { readonly output: unknown }) {
  const text = () => {
    const output = props.output
    if (typeof output === "string") return output
    if (Array.isArray(output)) {
      return output
        .map((block) => {
          if (block === null || typeof block !== "object") return String(block)
          const b = block as { type?: string; text?: string }
          if (b.type === "text" && typeof b.text === "string") return b.text
          if (b.type === "image") return "[image]"
          return JSON.stringify(b)
        })
        .join("\n")
    }
    return JSON.stringify(output, null, 2)
  }
  return <pre class="tool-output">{text()}</pre>
}

export function ToolCallCard(props: { readonly part: Extract<Part, { type: "tool_use" }> }) {
  const [expanded, setExpanded] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const statusClass = () => `tool-status ${props.part.status}`

  async function copyOutput(): Promise<void> {
    const part = props.part
    if (part.output === undefined) return
    const text =
      typeof part.output === "string"
        ? part.output
        : Array.isArray(part.output)
          ? part.output
              .map((block) => {
                if (block === null || typeof block !== "object") return String(block)
                const b = block as { text?: string }
                return typeof b.text === "string" ? b.text : ""
              })
              .join("\n")
          : JSON.stringify(part.output, null, 2)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable
    }
  }

  const isDiffTool = () => props.part.toolName === "Edit" || props.part.toolName === "Write"

  return (
    <div class={`tool-card ${props.part.status}`}>
      <button type="button" class="tool-card-header" onClick={() => setExpanded((prev) => !prev)}>
        <span class="fold-arrow">{expanded() ? "▾" : "▸"}</span>
        <span class={`tool-dot ${props.part.status}`} />
        <span class="tool-name">{props.part.toolName}</span>
        <span class={statusClass()}>{props.part.status}</span>
        <Show when={props.part.agentId !== undefined}>
          <span class="tool-agent" title="subagent">
            {props.part.agentId}
          </span>
        </Show>
      </button>
      <Show when={expanded()}>
        <div class="tool-card-body">
          <div class="tool-section">
            <div class="tool-section-label">Input</div>
            <PrettyJson value={props.part.input} />
          </div>
          <Show when={props.part.output !== undefined}>
            <div class="tool-section">
              <div class="tool-section-label">
                Output
                <Show when={isDiffTool()}>
                  <span class="tool-hint">(see Changes panel for the diff)</span>
                </Show>
                <button type="button" class="icon-btn small" onClick={() => void copyOutput()}>
                  {copied() ? "copied" : "copy"}
                </button>
              </div>
              <ToolOutput output={props.part.output} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

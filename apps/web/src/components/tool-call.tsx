import type { Part, ToolStatusType } from "@wren/protocol"
import { createMemo, createSignal, For, Show } from "solid-js"

type ToolUsePart = Extract<Part, { type: "tool_use" }>

const TOOL_LABELS: Readonly<Record<string, string>> = {
  bash: "Shell",
  bashtool: "Shell",
  read: "Read",
  filereadtool: "Read",
  write: "Write",
  filewritetool: "Write",
  edit: "Edit",
  fileedittool: "Edit",
  glob: "Glob",
  globtool: "Glob",
  grep: "Grep",
  greptool: "Grep",
  webfetch: "Webfetch",
  websearch: "Web Search",
  todowrite: "Todos",
  todowritetool: "Todos",
  agent: "Agent",
  taskoutput: "Task Output",
  taskstop: "Task Stop",
  askuserquestion: "Questions",
  skill: "Skill",
  localmemoryrecall: "Memory",
  enterplanmode: "Enter Plan",
  exitplanmode: "Exit Plan",
  notebookedit: "Notebook",
  brief: "Brief",
  sleep: "Sleep",
  ctxinspect: "Context",
}

function toolLabel(toolName: string): string {
  const lower = toolName.toLowerCase()
  return TOOL_LABELS[lower] ?? toolName
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function toolDetail(toolName: string, input: unknown): string {
  const lower = toolName.toLowerCase()
  const rec = recordValue(input)
  if (!rec) return ""
  if (lower === "bash" || lower === "bashtool") {
    return stringValue(rec.command) ?? ""
  }
  if (lower === "read" || lower === "filereadtool") {
    return stringValue(rec.file_path ?? rec.path) ?? ""
  }
  if (lower === "edit" || lower === "fileedittool") {
    return stringValue(rec.file_path ?? rec.path) ?? ""
  }
  if (lower === "write" || lower === "filewritetool") {
    return stringValue(rec.file_path ?? rec.path) ?? ""
  }
  if (lower === "glob" || lower === "globtool" || lower === "grep" || lower === "greptool") {
    return stringValue(rec.pattern) ?? ""
  }
  if (lower === "webfetch") return stringValue(rec.url) ?? ""
  if (lower === "websearch") return stringValue(rec.query) ?? ""
  if (lower === "agent") return stringValue(rec.description) ?? ""
  if (lower === "todowrite" || lower === "todowritetool") return ""
  return ""
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (output !== null && typeof output === "object") return JSON.stringify(output, null, 2)
  return ""
}

function outputLineCount(output: string): number {
  if (output === "") return 0
  return output.split("\n").length
}

const STATUS_ICON: Record<ToolStatusType, string> = {
  running: "▶",
  pending: "○",
  completed: "✓",
  failed: "✗",
}

function isEditTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return lower === "edit" || lower === "fileedittool"
}

function isWriteTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return lower === "write" || lower === "filewritetool"
}

function isTodoTool(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return lower === "todowrite" || lower === "todowritetool"
}

type DiffLine = { type: "added" | "removed" | "context"; text: string }

function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")
  const m = oldLines.length
  const n = newLines.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] =
        oldLines[i] === newLines[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "context", text: oldLines[i]! })
      i++; j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      result.push({ type: "removed", text: oldLines[i]! })
      i++
    } else {
      result.push({ type: "added", text: newLines[j]! })
      j++
    }
  }
  while (i < m) { result.push({ type: "removed", text: oldLines[i]! }); i++ }
  while (j < n) { result.push({ type: "added", text: newLines[j]! }); j++ }
  return result
}

export function ToolCallCard(props: { readonly part: ToolUsePart }) {
  const [expanded, setExpanded] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const label = () => toolLabel(props.part.toolName)
  const detail = () => toolDetail(props.part.toolName, props.part.input)
  const output = createMemo(() => formatOutput(props.part.output))
  const hasOutput = createMemo(() => output().trim().length > 0)
  const lineCount = createMemo(() => outputLineCount(output()))

  const isEdit = () => isEditTool(props.part.toolName)
  const isWrite = () => isWriteTool(props.part.toolName)
  const isTodo = () => isTodoTool(props.part.toolName)

  const editStrings = createMemo(() => {
    const rec = recordValue(props.part.input)
    if (!rec) return { old: "", new: "" }
    return {
      old: stringValue(rec.old_string ?? rec.oldString) ?? "",
      new: stringValue(rec.new_string ?? rec.newString) ?? "",
    }
  })
  const editDiff = createMemo(() =>
    editStrings().old !== "" || editStrings().new !== ""
      ? computeLineDiff(editStrings().old, editStrings().new)
      : [],
  )

  const todoItems = createMemo(() => {
    if (!isTodo()) return []
    const rec = recordValue(props.part.input)
    if (!rec) return []
    const todos = Array.isArray(rec.todos) ? rec.todos : []
    return todos as { status?: string; content?: string; activeForm?: string }[]
  })

  async function copyOutput(): Promise<void> {
    if (!hasOutput()) return
    try {
      await navigator.clipboard.writeText(output())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div class={`tool-card ${props.part.status}`}>
      <button type="button" class="tool-card-header" onClick={() => setExpanded((p) => !p)}>
        <span class="fold-arrow">{expanded() ? "▾" : "▸"}</span>
        <span class={`tool-dot ${props.part.status}`} />
        <span class="tool-name">{label()}</span>
        <Show when={detail() !== ""}>
          <span class="tool-detail-inline">{truncate(detail(), 60)}</span>
        </Show>
        <Show when={hasOutput() && !expanded()}>
          <span class="tool-output-count">{lineCount()} {lineCount() === 1 ? "line" : "lines"}</span>
        </Show>
        <span class={`tool-status ${props.part.status}`}>{STATUS_ICON[props.part.status]}</span>
      </button>
      <Show when={expanded()}>
        <div class="tool-card-body">
          {/* Edit diff view */}
          <Show when={isEdit() && editDiff().length > 0}>
            <div class="tool-section">
              <div class="tool-section-label">Diff</div>
              <pre class="tool-diff">
                <For each={editDiff()}>
                  {(line) => (
                    <div class={`diff-line ${line.type === "added" ? "add" : line.type === "removed" ? "del" : "ctx"}`}>
                      <span class="diff-line-text">
                        {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
                        {line.text}
                      </span>
                    </div>
                  )}
                </For>
              </pre>
            </div>
          </Show>

          {/* Todo items */}
          <Show when={isTodo() && todoItems().length > 0}>
            <div class="tool-section">
              <div class="tool-section-label">Todos</div>
              <div class="tool-todo-list">
                <For each={todoItems()}>
                  {(todo) => {
                    const marker = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : " "
                    return (
                      <div class={`tool-todo-item ${todo.status ?? ""}`}>
                        <span class="tool-todo-marker">{marker}</span>
                        <span>{todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}</span>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>

          {/* Raw input for non-special tools */}
          <Show when={!isEdit() && !isTodo() && !isWrite()}>
            <div class="tool-section">
              <div class="tool-section-label">Input</div>
              <pre class="json-block">{JSON.stringify(props.part.input, null, 2)}</pre>
            </div>
          </Show>

          {/* Output */}
          <Show when={hasOutput()}>
            <div class="tool-section">
              <div class="tool-section-label">
                Output
                <button type="button" class="icon-btn small" onClick={() => void copyOutput()}>
                  {copied() ? "copied" : "copy"}
                </button>
              </div>
              <pre class="tool-output">{output()}</pre>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

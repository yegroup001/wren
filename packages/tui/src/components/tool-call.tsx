import { TextAttributes } from "@opentui/core"
import type { Part, SessionId, ToolStatusType } from "@wren/protocol"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useClipboard } from "../context/clipboard"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import type { TuiTheme } from "../theme/themes"
import { Spinner } from "../ui/spinner"
import { useSyntaxStyle } from "./syntax"

type ToolUsePart = Extract<Part, { type: "tool_use" }>
type ToolResultPart = Extract<Part, { type: "tool_result" }>

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

export function toolTypeLabel(toolName: string, input?: unknown): string {
  const lower = toolName.toLowerCase()
  const base = TOOL_LABELS[lower] ?? toolName
  if (lower === "skill") {
    const rec = recordValue(input)
    const name = rec
      ? (stringValue(rec.skill) ??
        stringValue(rec.skillName) ??
        stringValue(rec.skill_name) ??
        stringValue(rec.name))
      : undefined
    return name ? `Skill: ${name}` : base
  }
  return base
}

type StatusColorKey = "textMuted" | "warning" | "success" | "error"
type ToolColorKey =
  | "toolBash"
  | "toolRead"
  | "toolWrite"
  | "toolWeb"
  | "toolTodo"
  | "toolAgent"
  | "toolPlan"
  | "toolDefault"

export function statusColorKey(status: ToolStatusType): StatusColorKey {
  switch (status) {
    case "pending":
      return "textMuted"
    case "running":
      return "warning"
    case "completed":
      return "success"
    case "failed":
      return "error"
    default:
      return "textMuted"
  }
}

export function toolColorKey(toolName: string): ToolColorKey {
  const lower = toolName.toLowerCase()
  if (lower === "bash" || lower === "bashtool") return "toolBash"
  if (
    lower === "read" ||
    lower === "glob" ||
    lower === "grep" ||
    lower === "filereadtool" ||
    lower === "globtool" ||
    lower === "greptool"
  )
    return "toolRead"
  if (
    lower === "write" ||
    lower === "edit" ||
    lower === "filewritetool" ||
    lower === "fileedittool" ||
    lower === "notebookedit"
  )
    return "toolWrite"
  if (lower === "webfetch" || lower === "websearch") return "toolWeb"
  if (lower === "todowrite" || lower === "todowritetool") return "toolTodo"
  if (lower === "agent" || lower === "taskoutput" || lower === "taskstop") return "toolAgent"
  if (lower === "enterplanmode" || lower === "exitplanmode") return "toolPlan"
  return "toolDefault"
}

export function toolAccent(theme: TuiTheme, toolName: string, status: ToolStatusType): string {
  if (status === "failed" || status === "running" || status === "pending") {
    return theme[statusColorKey(status)]
  }
  return theme[toolColorKey(toolName)]
}

export function toolIcon(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower === "bash" || lower === "bashtool") return "$"
  if (lower === "read" || lower === "filereadtool") return "\u2192"
  if (lower === "glob" || lower === "globtool") return "\u2731"
  if (lower === "grep" || lower === "greptool") return "\u2731"
  if (lower === "write" || lower === "filewritetool") return "\u2190"
  if (lower === "edit" || lower === "fileedittool") return "\u2190"
  if (lower === "notebookedit") return "\u2190"
  if (lower === "webfetch") return "%"
  if (lower === "websearch") return "\u25c8"
  if (lower === "todowrite" || lower === "todowritetool") return "\u2699"
  if (lower === "agent") return "\u25b8"
  if (lower === "taskoutput" || lower === "taskstop") return "\u25b8"
  if (lower === "skill") return "\u2605"
  if (lower === "localmemoryrecall") return "\u25c6"
  if (lower === "enterplanmode") return "\u25cb"
  if (lower === "exitplanmode") return "\u25cf"
  if (lower === "brief") return "\u272a"
  if (lower === "sleep") return "\u23f1"
  if (lower === "ctxinspect") return "\u2139"
  return "\u2699"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function toolDetail(toolName: string, input: unknown): string {
  const lower = toolName.toLowerCase()
  const rec = recordValue(input)
  if (!rec) return ""
  if (lower === "bash" || lower === "bashtool") {
    return stringValue(rec.command) ?? ""
  }
  if (
    lower === "read" ||
    lower === "edit" ||
    lower === "write" ||
    lower === "filereadtool" ||
    lower === "fileedittool" ||
    lower === "filewritetool" ||
    lower === "notebookedit"
  ) {
    return stringValue(rec.file_path ?? rec.path ?? rec.notebook_path) ?? ""
  }
  if (lower === "glob" || lower === "globtool" || lower === "grep" || lower === "greptool") {
    return stringValue(rec.pattern) ?? ""
  }
  if (lower.includes("webfetch")) {
    return stringValue(rec.url) ?? ""
  }
  if (lower.includes("websearch")) {
    return stringValue(rec.query) ?? ""
  }
  if (lower === "agent") {
    return stringValue(rec.agent_type ?? rec.description) ?? ""
  }
  if (lower === "taskoutput" || lower === "taskstop") {
    return stringValue(rec.task_id) ?? ""
  }
  if (lower === "localmemoryrecall") {
    return stringValue(rec.query ?? rec.key) ?? ""
  }
  if (lower === "brief") {
    return stringValue(rec.text ?? rec.message) ?? ""
  }
  if (lower === "ctxinspect") {
    return stringValue(rec.section ?? rec.query) ?? ""
  }
  return ""
}

export function formatOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (output !== null && typeof output === "object") return JSON.stringify(output, null, 2)
  return ""
}

export function outputLineCount(output: string): number {
  if (output === "") return 0
  return output.split("\n").length
}

export function leftTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `\u2026${text.slice(-(maxLen - 1))}`
}

export function rightTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}\u2026`
}

export function extractAgentId(output: unknown): string | undefined {
  if (typeof output === "string") {
    const match = output.match(/agentId:\s*(\S+)/)
    return match?.[1]
  }
  // Agent tool output is an array of content blocks: [{type:"text", text:"agentId: aXXX..."}]
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

export function ToolCallView(props: { part: ToolUsePart; sessionId: string }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)

  const toggle = (): void => {
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={expanded()} fallback={<InlineTool part={props.part} onToggle={toggle} />}>
      <BlockTool part={props.part} sessionId={props.sessionId} onToggle={toggle} />
    </Show>
  )
}

function InlineTool(props: { part: ToolUsePart; onToggle: () => void }): JSX.Element {
  const { theme } = useTheme()
  const label = (): string => toolTypeLabel(props.part.toolName, props.part.input)
  const detail = (): string => toolDetail(props.part.toolName, props.part.input)
  const isBash = (): boolean => {
    const lower = props.part.toolName.toLowerCase()
    return lower === "bash" || lower === "bashtool"
  }
  const truncatedDetail = (): string => {
    const d = detail()
    if (!d) return ""
    return isBash() ? rightTruncate(d, 50) : leftTruncate(d, 50)
  }
  const icon = (): string =>
    props.part.status === "failed" ? "\u2717" : toolIcon(props.part.toolName)
  const color = (): string => toolAccent(theme(), props.part.toolName, props.part.status)
  const isPending = (): boolean => props.part.status === "pending"
  const isFailed = (): boolean => props.part.status === "failed"
  const isAgent = (): boolean => props.part.toolName.toLowerCase() === "agent"
  const textAttrs = (): number => (isAgent() ? TextAttributes.BOLD : 0)
  const output = createMemo(() => formatOutput(props.part.output))
  const hasOutput = createMemo(() => output().trim().length > 0)
  const lineCount = createMemo(() => outputLineCount(output()))

  return (
    <box width="100%" paddingLeft={3} onMouseUp={props.onToggle}>
      <Show
        when={!isPending()}
        fallback={
          <box flexDirection="row">
            <Spinner style="dots" color={color()} />
            <text fg={color()} wrapMode="none" attributes={textAttrs()}>{` ${label()}`}</text>
            <Show when={truncatedDetail() !== ""}>
              <text fg={theme().textMuted} wrapMode="none">{` ${truncatedDetail()}`}</text>
            </Show>
          </box>
        }
      >
        <Show
          when={isFailed()}
          fallback={
            <box width="100%" flexDirection="row">
              <Show
                when={props.part.status === "running"}
                fallback={
                  <text flexShrink={0} fg={color()} attributes={textAttrs()}>{`${icon()} `}</text>
                }
              >
                <Spinner style="dots" color={color()} />
              </Show>
              <text fg={color()} wrapMode="none" attributes={textAttrs()}>
                {label()}
              </text>
              <Show when={truncatedDetail() !== ""}>
                <text fg={theme().textMuted} wrapMode="none">{` ${truncatedDetail()}`}</text>
              </Show>
              <Show when={hasOutput()}>
                <text
                  fg={theme().textMuted}
                  wrapMode="none"
                >{` (${lineCount()} ${lineCount() === 1 ? "line" : "lines"})`}</text>
              </Show>
              <box flexGrow={1} />
              <text flexShrink={0} fg={theme().textMuted}>
                {"\u25b8"}
              </text>
            </box>
          }
        >
          <box width="100%" flexDirection="row">
            <text flexShrink={0} fg={theme().error}>
              {"\u2717 "}
            </text>
            <text fg={theme().error} wrapMode="none" attributes={textAttrs()}>
              {label()}
            </text>
            <Show when={truncatedDetail() !== ""}>
              <text fg={theme().textMuted} wrapMode="none">{` ${truncatedDetail()}`}</text>
            </Show>
            <box flexGrow={1} />
            <text flexShrink={0} fg={theme().textMuted}>
              {"\u25b8"}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

export function editStrings(input: unknown): { oldString: string; newString: string } {
  const rec = recordValue(input)
  if (!rec) return { oldString: "", newString: "" }
  return {
    oldString: stringValue(rec.old_string ?? rec.oldString) ?? "",
    newString: stringValue(rec.new_string ?? rec.newString) ?? "",
  }
}

type DiffLine = {
  readonly type: "added" | "removed" | "context"
  readonly text: string
  readonly oldNum?: number
  readonly newNum?: number
}

export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")
  const m = oldLines.length
  const n = newLines.length

  // LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const oldLine = oldLines[i]!
      const newLine = newLines[j]!
      dp[i]![j] =
        oldLine === newLine
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    const oldLine = oldLines[i]!
    const newLine = newLines[j]!
    if (oldLine === newLine) {
      result.push({ type: "context", text: oldLine, oldNum: i + 1, newNum: j + 1 })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      result.push({ type: "removed", text: oldLine, oldNum: i + 1 })
      i++
    } else {
      result.push({ type: "added", text: newLine, newNum: j + 1 })
      j++
    }
  }
  while (i < m) {
    result.push({ type: "removed", text: oldLines[i]!, oldNum: i + 1 })
    i++
  }
  while (j < n) {
    result.push({ type: "added", text: newLines[j]!, newNum: j + 1 })
    j++
  }
  return result
}

function BlockTool(props: {
  part: ToolUsePart
  sessionId: string
  onToggle: () => void
}): JSX.Element {
  const { theme } = useTheme()
  const clipboard = useClipboard()
  const syntax = useSyntaxStyle()
  const { navigate } = useRoute()
  const [copyHover, setCopyHover] = createSignal(false)
  const label = (): string => toolTypeLabel(props.part.toolName, props.part.input)
  const detail = (): string => toolDetail(props.part.toolName, props.part.input)
  const icon = (): string => toolIcon(props.part.toolName)
  const color = (): string => toolAccent(theme(), props.part.toolName, props.part.status)
  const output = createMemo(() => formatOutput(props.part.output))
  const outputLines = createMemo(() => outputLineCount(output()))
  const isFailed = (): boolean => props.part.status === "failed"
  const isAgent = (): boolean => props.part.toolName.toLowerCase() === "agent"
  const agentId = createMemo(() => props.part.agentId ?? extractAgentId(props.part.output))
  const canViewSubagent = createMemo(
    () => isAgent() && agentId() !== undefined && props.part.status !== "pending",
  )
  const isWrite = (): boolean => props.part.toolName.toLowerCase().includes("write")
  const isEdit = (): boolean => {
    const lower = props.part.toolName.toLowerCase()
    return lower === "edit" || lower === "fileedittool"
  }
  const editOld = createMemo(() => editStrings(props.part.input).oldString)
  const editNew = createMemo(() => editStrings(props.part.input).newString)
  const hasEditDiff = createMemo(() => editOld() !== "" || editNew() !== "")
  const editDiffLines = createMemo(() =>
    hasEditDiff() ? computeLineDiff(editOld(), editNew()) : [],
  )
  const writeContent = createMemo(() => {
    const rec = recordValue(props.part.input)
    return stringValue(rec?.content) ?? ""
  })
  const writePath = createMemo(() => {
    const rec = recordValue(props.part.input)
    return stringValue(rec?.file_path ?? rec?.path) ?? ""
  })
  const ext = createMemo(() => {
    const parts = writePath().split(".")
    return parts.length > 1 ? (parts.at(-1) ?? "text") : "text"
  })
  const isTodo = (): boolean => {
    const lower = props.part.toolName.toLowerCase()
    return lower === "todowrite" || lower === "todowritetool"
  }
  const todoItems = createMemo(() => {
    if (!isTodo()) return []
    const rec = recordValue(props.part.input)
    if (!rec) return []
    const todos = Array.isArray(rec.todos) ? rec.todos : []
    return todos as { status?: string; content?: string; activeForm?: string }[]
  })

  return (
    <box
      border={["left"]}
      borderColor={isFailed() ? theme().error : color()}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={3}
      flexShrink={0}
    >
      <box flexDirection="row">
        <box flexDirection="row" flexGrow={1} onMouseUp={props.onToggle}>
          <Show
            when={props.part.status === "running"}
            fallback={
              <text
                flexShrink={0}
                fg={color()}
                attributes={isAgent() ? TextAttributes.BOLD : 0}
              >{`${icon()} `}</text>
            }
          >
            <Spinner style="dots" color={color()} />
          </Show>
          <text
            flexGrow={1}
            fg={color()}
            wrapMode="none"
            attributes={isAgent() ? TextAttributes.BOLD : 0}
          >
            {`${label()}${detail() ? ` ${detail()}` : ""}`}
          </text>
          <text flexShrink={0} fg={theme().textMuted}>
            {"\u25be"}
          </text>
        </box>
        <Show when={output() !== ""}>
          <box
            paddingLeft={1}
            paddingRight={1}
            onMouseOver={() => setCopyHover(true)}
            onMouseOut={() => setCopyHover(false)}
            onMouseUp={() => void clipboard.copy(output())}
          >
            <text fg={copyHover() ? theme().text : theme().textMuted}>{"[copy]"}</text>
          </box>
        </Show>
      </box>
      <Show when={isWrite() && writeContent() !== "" && props.part.status === "completed"}>
        <scrollbox
          maxHeight={Math.min(outputLineCount(writeContent()), 15)}
          paddingLeft={1}
          paddingTop={1}
        >
          <line_number fg={theme().textMuted} minWidth={3} paddingRight={1}>
            <code
              filetype={ext()}
              syntaxStyle={syntax()}
              content={writeContent()}
              fg={theme().text}
            />
          </line_number>
        </scrollbox>
      </Show>
      <Show when={isEdit() && hasEditDiff()}>
        <scrollbox
          paddingLeft={1}
          paddingTop={1}
          maxHeight={Math.min(editDiffLines().length, 15)}
          scrollX={true}
          flexShrink={0}
        >
          <For each={editDiffLines()}>
            {(line) => (
              <box flexDirection="row">
                <text
                  fg={theme().textMuted}
                  wrapMode="none"
                  flexShrink={0}
                  minWidth={4}
                >
                  {line.type === "added" ? "    " : `${String(line.oldNum).padStart(3, " ")} `}
                </text>
                <text
                  fg={theme().textMuted}
                  wrapMode="none"
                  flexShrink={0}
                  minWidth={4}
                >
                  {line.type === "removed" ? "    " : `${String(line.newNum).padStart(3, " ")} `}
                </text>
                <text
                  fg={
                    line.type === "removed"
                      ? theme().diffRemoved
                      : line.type === "added"
                        ? theme().diffAdded
                        : theme().textMuted
                  }
                  wrapMode="none"
                >
                  {line.type === "removed"
                    ? `- ${line.text}`
                    : line.type === "added"
                      ? `+ ${line.text}`
                      : `  ${line.text}`}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <Show when={isFailed() && output() !== ""}>
          <box paddingLeft={1} paddingTop={1} flexShrink={0}>
            <text fg={theme().error} wrapMode="word">
              {output()}
            </text>
          </box>
        </Show>
      </Show>
      <Show when={isEdit() && !hasEditDiff() && props.part.status === "completed"}>
        <box paddingLeft={1} paddingTop={1} flexShrink={0}>
          <text fg={theme().textMuted} wrapMode="word">
            {output() || "Applied"}
          </text>
        </box>
      </Show>
      <Show when={isEdit() && !hasEditDiff() && isFailed() && output() !== ""}>
        <box paddingLeft={1} paddingTop={1} flexShrink={0}>
          <text fg={theme().error} wrapMode="word">
            {output()}
          </text>
        </box>
      </Show>
      <Show when={isTodo() && todoItems().length > 0 && props.part.status === "completed"}>
        <scrollbox
          paddingLeft={1}
          paddingTop={1}
          maxHeight={Math.min(todoItems().length, 15)}
          flexShrink={0}
        >
          <For each={todoItems()}>
            {(todo) => {
              const marker =
                todo.status === "completed"
                  ? "\u2713"
                  : todo.status === "in_progress"
                    ? "\u2022"
                    : " "
              const itemColor =
                todo.status === "completed"
                  ? theme().success
                  : todo.status === "in_progress"
                    ? theme().warning
                    : theme().textMuted
              const label =
                todo.status === "in_progress" && todo.activeForm
                  ? todo.activeForm
                  : (todo.content ?? "")
              return (
                <text fg={itemColor} wrapMode="none">
                  {`[${marker}] ${label}`}
                </text>
              )
            }}
          </For>
        </scrollbox>
      </Show>
      <Show when={output() !== "" && !isEdit() && !isTodo()}>
        <scrollbox
          maxHeight={Math.min(outputLines(), 15)}
          paddingTop={1}
          scrollX={true}
        >
          <text fg={isFailed() ? theme().error : theme().text} wrapMode="none">
            {output()}
          </text>
        </scrollbox>
      </Show>
      <Show when={canViewSubagent()}>
        <box
          flexDirection="row"
          paddingLeft={1}
          paddingTop={1}
          onMouseUp={() =>
            navigate({
              type: "subagent",
              sessionId: props.sessionId as SessionId,
              // biome-ignore lint/style/noNonNullAssertion: agentId extracted above
              agentId: agentId()!,
              description: detail(),
              agentStatus: props.part.status,
            })
          }
        >
          <text fg={theme().textMuted}>{"[View subagent transcript]"}</text>
        </box>
      </Show>
    </box>
  )
}

export function ToolResultView(props: { part: ToolResultPart }): JSX.Element {
  const { theme } = useTheme()
  const content = (): string => formatOutput(props.part.content)

  return (
    <Show when={content() !== ""}>
      <box border={["left"]} borderColor={theme().tool} paddingLeft={2} marginTop={1} flexShrink={0}>
        <text fg={theme().textMuted} wrapMode="word">
          {content()}
        </text>
      </box>
    </Show>
  )
}

import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs"
import { z } from "zod/v4"
import type { ToolUseContext } from "src/Tool.js"
import { buildTool, type ToolDef } from "src/Tool.js"
import { lazySchema } from "src/utils/lazySchema.js"
import { sleep } from "src/utils/sleep.js"
import { AbortError } from "src/utils/errors.js"
import { extractTextContent } from "src/utils/messages.js"
import { getTaskOutput } from "src/utils/task/diskOutput.js"
import { updateTaskState } from "src/utils/task/framework.js"
import { TASK_OUTPUT_TOOL_NAME } from "./constants.js"

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe("The task ID to get output from"),
    block: z.boolean().default(true).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(600000).default(30000).describe("Max wait time in ms"),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type TaskOutputToolInput = z.infer<InputSchema>

type TaskOutput = {
  task_id: string
  task_type: string
  status: string
  description: string
  output: string
  exitCode?: number | null
  error?: string
  prompt?: string
  result?: string
}

type TaskOutputToolOutput = {
  retrieval_status: "success" | "timeout" | "not_ready"
  task: TaskOutput | null
}

// getTaskOutput reads from disk and returns '' on ENOENT, but wrap it so
// any other unexpected error (permission, EISDIR, …) degrades to '' too
// instead of failing the tool call.
async function readTaskOutputFromDisk(taskId: string): Promise<string> {
  try {
    return await getTaskOutput(taskId)
  } catch {
    return ""
  }
}

// Read task state and extract output, structurally. We deliberately use
// Record<string, unknown> at this boundary instead of importing the
// concrete LocalShellTaskState / LocalAgentTaskState types — those pull in
// .tsx modules we don't want in the headless build, and the shapes are
// stable enough to read structurally.
async function getTaskOutputData(task: Record<string, unknown>): Promise<TaskOutput> {
  const taskId = task["id"] as string
  const taskType = task["type"] as string
  const taskStatus = task["status"] as string
  const taskDescription = task["description"] as string

  let output: string
  const shellCommand = task["shellCommand"] as
    | {
        taskOutput?: {
          getStdout(): Promise<string>
          getStderr(): Promise<string>
        }
      }
    | undefined
  if (taskType === "local_bash" && shellCommand?.taskOutput) {
    const stdout = await shellCommand.taskOutput.getStdout()
    const stderr = await shellCommand.taskOutput.getStderr()
    output = [stdout, stderr].filter(Boolean).join("\n")
  } else {
    output = await readTaskOutputFromDisk(taskId)
  }

  const baseOutput: TaskOutput = {
    task_id: taskId,
    task_type: taskType,
    status: taskStatus,
    description: taskDescription,
    output,
  }

  if (taskType === "local_bash") {
    const result = task["result"] as { code?: number } | undefined
    return { ...baseOutput, exitCode: result?.code ?? null }
  }

  if (taskType === "local_agent") {
    const agentTask = task as {
      prompt?: string
      result?: { content: unknown }
      error?: string
    }
    const content = agentTask.result?.content as readonly { readonly type: string }[] | undefined
    const cleanResult = content ? extractTextContent(content, "\n") : undefined
    return {
      ...baseOutput,
      prompt: agentTask.prompt,
      result: cleanResult || output,
      output: cleanResult || output,
      error: agentTask.error,
    }
  }

  return baseOutput
}

// AppState is stubbed as `unknown` in this headless build, so callers cast
// the structural shape they need at the boundary.
type AppStateLike = {
  tasks?: Record<string, Record<string, unknown>>
}

// Poll AppState.tasks every 100ms until the task leaves running/pending or
// the timeout fires. Returns the final task state, or null if the task
// disappeared.
async function waitForTaskCompletion(
  taskId: string,
  getAppState: () => AppStateLike,
  timeoutMs: number,
  abortController?: AbortController,
): Promise<Record<string, unknown> | null> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (abortController?.signal.aborted) {
      throw new AbortError()
    }

    const state = getAppState()
    const task = state.tasks?.[taskId]

    if (!task) {
      return null
    }

    if (task["status"] !== "running" && task["status"] !== "pending") {
      return task
    }

    await sleep(100)
  }

  const finalState = getAppState()
  return finalState.tasks?.[taskId] ?? null
}

export const TaskOutputTool = buildTool({
  name: TASK_OUTPUT_TOOL_NAME,
  searchHint: "read output/logs from a background task",
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  aliases: ["AgentOutputTool", "BashOutputTool"],

  userFacingName() {
    return "Task Output"
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return "[Deprecated] — prefer Read on the task output file path"
  },

  isEnabled() {
    return true
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  toAutoClassifierInput(input) {
    return input.task_id
  },

  async prompt() {
    return `DEPRECATED: Prefer using the Read tool on the task's output file path instead. Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes — Read that file directly.

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`
  },

  async call(input: TaskOutputToolInput, toolUseContext) {
    const { task_id, block, timeout } = input

    const appState = toolUseContext.getAppState() as AppStateLike
    const task = appState.tasks?.[task_id]

    if (!task) {
      throw new Error(`No task found with ID: ${task_id}`)
    }

    if (!block) {
      if (task["status"] !== "running" && task["status"] !== "pending") {
        updateTaskState(task_id, toolUseContext.setAppState, (t) =>
          Object.assign({}, t, { notified: true }),
        )
        return {
          data: {
            retrieval_status: "success" as const,
            task: await getTaskOutputData(task),
          },
        }
      }
      return {
        data: {
          retrieval_status: "not_ready" as const,
          task: await getTaskOutputData(task),
        },
      }
    }

    const completedTask = await waitForTaskCompletion(
      task_id,
      () => toolUseContext.getAppState() as AppStateLike,
      timeout,
      toolUseContext.abortController,
    )

    if (!completedTask) {
      return {
        data: {
          retrieval_status: "timeout" as const,
          task: null,
        },
      }
    }

    if (completedTask["status"] === "running" || completedTask["status"] === "pending") {
      return {
        data: {
          retrieval_status: "timeout" as const,
          task: await getTaskOutputData(completedTask),
        },
      }
    }

    updateTaskState(task_id, toolUseContext.setAppState, (t) =>
      Object.assign({}, t, { notified: true }),
    )

    return {
      data: {
        retrieval_status: "success" as const,
        task: await getTaskOutputData(completedTask),
      },
    }
  },

  mapToolResultToToolResultBlockParam(
    data: TaskOutputToolOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const parts: string[] = []

    parts.push(`<retrieval_status>${data.retrieval_status}</retrieval_status>`)

    if (data.task) {
      parts.push(`<task_id>${data.task.task_id}</task_id>`)
      parts.push(`<task_type>${data.task.task_type}</task_type>`)
      parts.push(`<status>${data.task.status}</status>`)

      if (data.task.exitCode !== undefined && data.task.exitCode !== null) {
        parts.push(`<exit_code>${data.task.exitCode}</exit_code>`)
      }

      if (data.task.output?.trim()) {
        parts.push(`<output>\n${data.task.output.trimEnd()}\n</output>`)
      }

      if (data.task.error) {
        parts.push(`<error>${data.task.error}</error>`)
      }
    }

    return {
      tool_use_id: toolUseID,
      type: "tool_result" as const,
      content: parts.join("\n\n"),
    }
  },

} satisfies ToolDef<InputSchema, TaskOutputToolOutput>)

export default TaskOutputTool

import { z } from "zod/v4"
import type { ToolResultBlockParam } from "src/Tool.js"
import { buildTool } from "src/Tool.js"
import { lazySchema } from "src/utils/lazySchema.js"
import { SLEEP_TOOL_NAME, DESCRIPTION, SLEEP_TOOL_PROMPT } from "./prompt.js"
import { hasCommandsInQueue } from "../../utils/messageQueueManager.js"

const SLEEP_WAKE_CHECK_INTERVAL_MS = 500

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration_seconds: z
      .number()
      .describe("How long to sleep in seconds. Can be interrupted by the user at any time."),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SleepInput = z.infer<InputSchema>

type SleepOutput = { slept_seconds: number; interrupted: boolean }

function hasQueuedWakeSignal(): boolean {
  return hasCommandsInQueue()
}

function shouldInterruptSleep(): boolean {
  return hasQueuedWakeSignal()
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: "wait pause sleep rest idle duration timer",
  maxResultSizeChars: 1_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return "cancel"
  },

  userFacingName() {
    return SLEEP_TOOL_NAME
  },


  mapToolResultToToolResultBlockParam(
    content: SleepOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const msg = content.interrupted
      ? `Sleep interrupted after ${content.slept_seconds}s`
      : `Slept for ${content.slept_seconds}s`
    return {
      tool_use_id: toolUseID,
      type: "tool_result",
      content: msg,
    }
  },

  async call(input: SleepInput, context) {
    // Don't enter sleep if new work arrived while the model was deciding to wait.
    if (shouldInterruptSleep()) {
      return {
        data: {
          slept_seconds: 0,
          interrupted: true,
        },
      }
    }

    const { duration_seconds } = input
    const startTime = Date.now()
    const sleepUntil = startTime + duration_seconds * 1000

    try {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        let wakeCheck: ReturnType<typeof setInterval> | null = null
        let settled = false

        const cleanup = () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          if (wakeCheck !== null) {
            clearInterval(wakeCheck)
            wakeCheck = null
          }
          context.abortController.signal.removeEventListener("abort", onAbort)
        }

        const finish = () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        }

        const interrupt = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error("interrupted"))
        }

        const onAbort = () => {
          interrupt()
        }

        timer = setTimeout(finish, duration_seconds * 1000)

        // Abort via user interrupt
        if (context.abortController.signal.aborted) {
          interrupt()
          return
        }
        context.abortController.signal.addEventListener("abort", onAbort, {
          once: true,
        })

        // Poll the shared command queue so new work can
        // wake Sleep without waiting for the full duration.
        wakeCheck = setInterval(() => {
          if (shouldInterruptSleep()) {
            interrupt()
          }
        }, SLEEP_WAKE_CHECK_INTERVAL_MS)
      })
      return {
        data: {
          slept_seconds: duration_seconds,
          interrupted: false,
        },
      }
    } catch {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      return {
        data: {
          slept_seconds: elapsed,
          interrupted: true,
        },
      }
    }
  },
})

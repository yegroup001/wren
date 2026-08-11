import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { ToolUseContext } from "src/Tool.js"

const persistCurrentGoal = mock(() => {})

mock.module("src/services/goal/goalStorage.js", () => ({
  persistCurrentGoal,
}))

const { GoalTool } = await import("../GoalTool.js")
const { _clearAllGoalsForTesting, getGoal, setGoal } = await import(
  "src/services/goal/goalState.js"
)

const SESSION_A = "goal-tool-session-a"
const SESSION_B = "goal-tool-session-b"

function contextFor(sessionId: string): ToolUseContext {
  return {
    sessionStorageContext: {
      sessionId,
      projectPath: "/tmp/wren-goal-tool-test",
    },
  } as ToolUseContext
}

beforeEach(() => {
  _clearAllGoalsForTesting()
  persistCurrentGoal.mockClear()
})

describe("GoalTool session isolation", () => {
  test("reads the active goal from the tool execution session", async () => {
    setGoal("goal for session A", { sessionId: SESSION_A })
    setGoal("goal for session B", { sessionId: SESSION_B })

    const result = await GoalTool.call({ action: "get" }, contextFor(SESSION_A))

    expect(result.data).toMatchObject({
      success: true,
      goal: {
        objective: "goal for session A",
        status: "Active",
      },
    })
  })

  test("completes and persists only the tool execution session's goal", async () => {
    setGoal("goal for session A", { sessionId: SESSION_A })
    setGoal("goal for session B", { sessionId: SESSION_B })

    const result = await GoalTool.call(
      { action: "update", status: "complete", reason: "all requirements verified" },
      contextFor(SESSION_A),
    )

    expect(result.data).toMatchObject({
      success: true,
      goal: {
        objective: "goal for session A",
        status: "Complete",
      },
    })
    expect(getGoal(SESSION_A)?.status).toBe("complete")
    expect(getGoal(SESSION_B)?.status).toBe("active")
    expect(persistCurrentGoal).toHaveBeenCalledWith(SESSION_A)
  })

  test("records a blocked attempt only against the tool execution session's goal", async () => {
    setGoal("goal for session A", { sessionId: SESSION_A })
    setGoal("goal for session B", { sessionId: SESSION_B })

    const result = await GoalTool.call(
      { action: "update", status: "blocked", reason: "missing credentials" },
      contextFor(SESSION_A),
    )

    expect(result.data.message).toContain("Blocked attempt 1 recorded")
    expect(result.data.goal).toMatchObject({
      objective: "goal for session A",
      status: "Active",
    })
    expect(getGoal(SESSION_A)?.blockedAttempts).toBe(1)
    expect(getGoal(SESSION_B)?.blockedAttempts).toBe(0)
    expect(persistCurrentGoal).toHaveBeenCalledWith(SESSION_A)
  })
})

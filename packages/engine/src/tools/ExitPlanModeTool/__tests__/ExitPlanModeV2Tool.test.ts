import { describe, expect, test } from "bun:test"
import type { ToolUseContext } from "src/Tool.js"
import { ExitPlanModeV2Tool } from "../ExitPlanModeV2Tool.js"

function context(planExitApprovalRequired?: boolean): ToolUseContext {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode: "plan",
        planExitApprovalRequired,
      },
    }),
  } as unknown as ToolUseContext
}

describe("ExitPlanMode permission source", () => {
  test("asks only when the user manually entered plan mode", async () => {
    const manual = await ExitPlanModeV2Tool.checkPermissions({}, context(true))
    const automatic = await ExitPlanModeV2Tool.checkPermissions({}, context(false))
    const unspecified = await ExitPlanModeV2Tool.checkPermissions({}, context())

    expect(manual).toMatchObject({ behavior: "ask", message: "Exit plan mode?" })
    expect(automatic.behavior).toBe("allow")
    expect(unspecified.behavior).toBe("allow")
    expect(ExitPlanModeV2Tool.requiresUserInteraction()).toBe(false)
  })

  test("restores the previous mode and clears plan-only state", async () => {
    for (const restoreMode of ["auto", "acceptEdits", "full"] as const) {
      let state = {
        toolPermissionContext: {
          mode: "plan" as const,
          prePlanMode: restoreMode,
          planExitApprovalRequired: false,
        },
      }
      const toolContext = {
        getAppState: () => state,
        setAppState: (update: (current: typeof state) => typeof state) => {
          state = update(state)
        },
        options: { tools: [] },
      } as unknown as ToolUseContext

      await ExitPlanModeV2Tool.call({}, toolContext)

      expect(state.toolPermissionContext.mode).toBe(restoreMode)
      expect(state.toolPermissionContext.prePlanMode).toBeUndefined()
      expect(state.toolPermissionContext.planExitApprovalRequired).toBeUndefined()
    }
  })

  test("does not claim user approval for an automatic exit", () => {
    const result = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(
      {
        plan: "Inspect the code, then implement.",
        isAgent: false,
        filePath: "/tmp/plan.md",
      },
      "tool_1",
    )

    expect(result.content).toContain("Exited plan mode")
    expect(result.content).not.toContain("User has approved")
    expect(result.content).toContain("## Plan:")
  })

  test("retains approval wording for a manual exit", () => {
    const result = ExitPlanModeV2Tool.mapToolResultToToolResultBlockParam(
      {
        plan: "Inspect the code, then implement.",
        isAgent: false,
        filePath: "/tmp/plan.md",
        userApproved: true,
      },
      "tool_2",
    )

    expect(result.content).toContain("User has approved your plan")
    expect(result.content).toContain("## Approved Plan:")
  })
})

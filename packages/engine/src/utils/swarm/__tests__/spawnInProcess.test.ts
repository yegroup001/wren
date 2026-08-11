import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setWrenConfigHomeForTests } from "@wren/config-node"
import { rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { getDefaultAppState } from "../../../state/AppStateStore"
import { clearConfigHomeCache } from "../../envUtils.js"
import { readMailbox, writeToMailbox } from "../../teammateMailbox"
import { killInProcessTeammateByAgentId, spawnInProcessTeammate } from "../spawnInProcess"

let tempHome: string

beforeEach(() => {
  tempHome = join(tmpdir(), `spawn-in-process-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  setWrenConfigHomeForTests(tempHome)
  clearConfigHomeCache()
})

afterEach(() => {
  setWrenConfigHomeForTests(undefined)
  clearConfigHomeCache()
  rmSync(tempHome, { recursive: true, force: true })
})

describe("killInProcessTeammateByAgentId", () => {
  test("registers a real in-process teammate task and mailbox", async () => {
    let state = getDefaultAppState() as any
    const result = await spawnInProcessTeammate(
      {
        name: "worker",
        teamName: "alpha",
        prompt: "smoke test task",
        color: "blue",
        planModeRequired: false,
      },
      {
        setAppState(updater) {
          state = updater(state)
        },
        toolUseId: "toolu_smoke",
      },
    )

    expect(result.success).toBe(true)
    expect(result.agentId).toBe("worker@alpha")
    expect(result.taskId).toBeString()
    expect(state.tasks[result.taskId!].type).toBe("in_process_teammate")
    expect(state.tasks[result.taskId!].identity.agentId).toBe("worker@alpha")
    expect(state.tasks[result.taskId!].messages).toEqual([])

    await writeToMailbox(
      "worker",
      {
        from: "team-lead",
        text: "mailbox smoke",
        timestamp: new Date(0).toISOString(),
      },
      "alpha",
    )
    const messages = await readMailbox("worker", "alpha")

    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe("mailbox smoke")
    expect(messages[0]!.read).toBe(false)
  })

  test("aborts the running teammate and removes it from team context by agent id", () => {
    const abortController = new AbortController()
    let state: any = {
      teamContext: {
        teamName: "alpha",
        teammates: {
          "worker@alpha": {
            name: "worker",
          },
        },
      },
      tasks: {
        teammate_task_1: {
          id: "teammate_task_1",
          type: "in_process_teammate",
          status: "running",
          identity: {
            agentId: "worker@alpha",
            agentName: "worker",
            teamName: "alpha",
            planModeRequired: false,
            parentSessionId: "session",
          },
          abortController,
          pendingUserMessages: [],
          onIdleCallbacks: [],
          messages: [],
        },
      },
    }

    const killed = killInProcessTeammateByAgentId("worker@alpha", (updater) => {
      state = updater(state)
    })

    expect(killed).toBe(true)
    expect(abortController.signal.aborted).toBe(true)
    expect(state.tasks.teammate_task_1.status).toBe("killed")
    expect(state.teamContext.teammates["worker@alpha"]).toBeUndefined()
  })
})

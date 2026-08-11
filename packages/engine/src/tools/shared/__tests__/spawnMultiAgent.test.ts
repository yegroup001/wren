import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setWrenConfigHomeForTests } from "@wren/config-node"
import { spawnTeammate } from "../spawnMultiAgent"
import { clearConfigHomeCache } from "src/utils/envUtils.js"

let tempHome: string

beforeEach(() => {
  tempHome = join(
    tmpdir(),
    `spawn-multi-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  setWrenConfigHomeForTests(tempHome)
  clearConfigHomeCache()
})

afterEach(() => {
  setWrenConfigHomeForTests(undefined)
  clearConfigHomeCache()
  rmSync(tempHome, { recursive: true, force: true })
})

describe("spawnTeammate", () => {
  test("fails before spawn side effects when the team file is missing", async () => {
    let setAppStateCalled = false
    const context = {
      getAppState: () => ({
        teamContext: undefined,
      }),
      setAppState: () => {
        setAppStateCalled = true
      },
      options: {
        agentDefinitions: {
          activeAgents: [],
        },
      },
    }

    await expect(
      spawnTeammate(
        {
          name: "worker",
          prompt: "do work",
          team_name: "missing-team",
        },
        context as any,
      ),
    ).rejects.toThrow('Team "missing-team" does not exist')
    expect(setAppStateCalled).toBe(false)
  })
})

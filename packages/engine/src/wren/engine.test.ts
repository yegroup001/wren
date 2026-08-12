import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod/v4"
import type { Tool, ToolUseContext } from "../Tool.js"
import { getEmptyToolPermissionContext } from "../Tool.js"
import type { AgentDefinition } from "../tools/AgentTool/loadAgentsDir.js"
import { EnterPlanModeTool } from "../tools/EnterPlanModeTool/EnterPlanModeTool.js"
import { ExitPlanModeV2Tool } from "../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js"
import { GlobTool } from "../tools/GlobTool/GlobTool.js"
import { GrepTool } from "../tools/GrepTool/GrepTool.js"
import type { PermissionDecision, PermissionMode } from "../types/permissions.js"
import { runWithTeammateContext } from "../utils/teammateContext.js"
import {
  checkEnterPlanPermission,
  checkPlanPermission,
  isPlanSafeToolInput,
  permissionContextForModeChange,
} from "./engine.js"

type ToolPermission = "allow" | "ask"

function fakeTool(name: string, permission: ToolPermission = "allow"): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    aliases: [],
    isMcp: false,
    requiresUserInteraction: () => false,
    isReadOnly: () => true,
    checkPermissions: async (input: Record<string, unknown>): Promise<PermissionDecision> =>
      permission === "allow"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "ask", message: "permission required" },
  } as unknown as Tool
}

function planContext(
  permissionOverrides: Partial<ReturnType<typeof getEmptyToolPermissionContext>> = {},
): ToolUseContext {
  const permissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: "plan" as PermissionMode,
    ...permissionOverrides,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permissionContext }),
    options: {},
  } as unknown as ToolUseContext
}

function mutableModeContext(initial: ReturnType<typeof getEmptyToolPermissionContext>): {
  readonly context: ToolUseContext
  readonly getPermissionContext: () => ReturnType<typeof getEmptyToolPermissionContext>
} {
  let state = { toolPermissionContext: initial }
  return {
    context: {
      getAppState: () => state,
      setAppState: (update) => {
        state = update(state as never) as typeof state
      },
    } as unknown as ToolUseContext,
    getPermissionContext: () => state.toolPermissionContext,
  }
}

const builtInAgent = (agentType: "Explore" | "Plan"): AgentDefinition =>
  ({ agentType, source: "built-in" }) as AgentDefinition

describe("plan permission policy", () => {
  test("tracks manual plan entry separately from automatic entry", () => {
    const initial = getEmptyToolPermissionContext()
    const manual = permissionContextForModeChange(initial, "plan", { source: "manual" })
    const automatic = permissionContextForModeChange(initial, "plan")

    expect(manual).toMatchObject({
      mode: "plan",
      prePlanMode: "default",
      planExitApprovalRequired: true,
    })
    expect(automatic).toMatchObject({
      mode: "plan",
      prePlanMode: "default",
      planExitApprovalRequired: false,
    })
    expect(permissionContextForModeChange(manual, "plan").planExitApprovalRequired).toBe(false)
    expect(
      permissionContextForModeChange(automatic, "plan", { source: "manual" })
        .planExitApprovalRequired,
    ).toBe(true)
    expect(permissionContextForModeChange(manual, "default")).toMatchObject({ mode: "default" })
    expect(permissionContextForModeChange(manual, "default").prePlanMode).toBeUndefined()
    expect(
      permissionContextForModeChange(manual, "default").planExitApprovalRequired,
    ).toBeUndefined()
  })

  test("restores every supported mode after automatic plan entry", () => {
    for (const mode of ["default", "auto", "acceptEdits", "full"] as const) {
      const initial = { ...getEmptyToolPermissionContext(), mode }
      const plan = permissionContextForModeChange(initial, "plan")
      const restored = permissionContextForModeChange(plan, mode)

      expect(plan).toMatchObject({
        mode: "plan",
        prePlanMode: mode,
        planExitApprovalRequired: false,
      })
      expect(restored.mode).toBe(mode)
      expect(restored.prePlanMode).toBeUndefined()
      expect(restored.planExitApprovalRequired).toBeUndefined()
    }
  })

  test("model EnterPlanMode creates an automatic exit and preserves an existing manual entry", async () => {
    for (const mode of ["default", "auto", "acceptEdits", "full"] as const) {
      const automatic = mutableModeContext({ ...getEmptyToolPermissionContext(), mode })
      await EnterPlanModeTool.call({}, automatic.context)
      expect(automatic.getPermissionContext()).toMatchObject({
        mode: "plan",
        prePlanMode: mode,
        planExitApprovalRequired: false,
      })
    }

    const manual = mutableModeContext({
      ...getEmptyToolPermissionContext(),
      mode: "plan",
      prePlanMode: "default",
      planExitApprovalRequired: true,
    })
    await EnterPlanModeTool.call({}, manual.context)
    expect(manual.getPermissionContext().planExitApprovalRequired).toBe(true)
  })

  test("auto-allows model EnterPlanMode unless an explicit ask rule applies", async () => {
    const enter = fakeTool("EnterPlanMode")
    let forcePrompt = false
    const allowed = await checkEnterPlanPermission(enter, {}, planContext())
    const asking = await checkEnterPlanPermission(
      enter,
      {},
      planContext({ alwaysAskRules: { session: ["EnterPlanMode"] } }),
      {
        onForcePrompt: () => {
          forcePrompt = true
        },
      },
    )

    expect(allowed?.behavior).toBe("allow")
    expect(asking).toBeNull()
    expect(forcePrompt).toBe(true)
  })

  test("auto-allows automatic ExitPlanMode but prompts after manual entry", async () => {
    const automatic = await checkPlanPermission(
      ExitPlanModeV2Tool,
      {},
      planContext({ planExitApprovalRequired: false }),
      [],
      [ExitPlanModeV2Tool],
      [],
    )
    const manual = await checkPlanPermission(
      ExitPlanModeV2Tool,
      {},
      planContext({ planExitApprovalRequired: true }),
      [],
      [ExitPlanModeV2Tool],
      [],
    )

    expect(automatic?.behavior).toBe("allow")
    expect(manual).toBeNull()
  })

  test("recognizes ordinary plan reads but not sensitive targets", () => {
    const read = fakeTool("Read")
    const grep = fakeTool("Grep")
    const glob = fakeTool("Glob")

    expect(isPlanSafeToolInput(read, { file_path: "/workspace/src/index.ts" })).toBe(true)
    expect(isPlanSafeToolInput(read, { file_path: "/workspace/.env" })).toBe(false)
    expect(isPlanSafeToolInput(grep, { pattern: "foo", path: "/workspace" })).toBe(true)
    expect(isPlanSafeToolInput(grep, { pattern: "foo", glob: "**/.github/**" })).toBe(true)
    expect(isPlanSafeToolInput(grep, { pattern: "foo", glob: "**/.gitignore" })).toBe(true)
    expect(isPlanSafeToolInput(grep, { pattern: "foo", glob: "**/.env*" })).toBe(false)
    expect(isPlanSafeToolInput(glob, { pattern: "src/**/*.ts" })).toBe(true)
    expect(isPlanSafeToolInput(glob, { pattern: "**/*.*" })).toBe(true)
    expect(isPlanSafeToolInput(glob, { pattern: "**/*.json" })).toBe(true)
    expect(isPlanSafeToolInput(glob, { pattern: "**/*config*" })).toBe(true)
    expect(isPlanSafeToolInput(glob, { pattern: "**/*", path: "/workspace/.ssh" })).toBe(false)
    expect(isPlanSafeToolInput(glob, { pattern: "**/.git/**" })).toBe(false)
    expect(isPlanSafeToolInput(glob, { pattern: "**/credentials.json" })).toBe(false)
    expect(isPlanSafeToolInput(glob, { pattern: "**/*.pem" })).toBe(false)
  })

  test("treats a benign symlink name pointing at a secret as sensitive", () => {
    const directory = mkdtempSync(join(tmpdir(), "wren-plan-permission-"))
    const secret = join(directory, ".env")
    const link = join(directory, "config.txt")

    try {
      writeFileSync(secret, "TOKEN=secret")
      symlinkSync(secret, link)
      expect(isPlanSafeToolInput(fakeTool("Read"), { file_path: link })).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("allows a workspace-safe Read after its tool permission check", async () => {
    const read = fakeTool("Read")
    const result = await checkPlanPermission(
      read,
      { file_path: "/workspace/src/index.ts" },
      planContext(),
      [],
      [read],
      [],
    )

    expect(result?.behavior).toBe("allow")
  })

  test("propagates explicit deny rules and leaves explicit ask rules interactive", async () => {
    const read = fakeTool("Read")
    const denied = await checkPlanPermission(
      read,
      { file_path: "/workspace/src/index.ts" },
      planContext({ alwaysDenyRules: { session: ["Read"] } }),
      [],
      [read],
      [],
    )
    const asking = await checkPlanPermission(
      read,
      { file_path: "/workspace/src/index.ts" },
      planContext({ alwaysAskRules: { session: ["Read"] } }),
      [],
      [read],
      [],
    )

    expect(denied?.behavior).toBe("deny")
    expect(asking).toBeNull()
  })

  test("returns sensitive reads to the normal permission flow", async () => {
    const read = fakeTool("Read")
    const result = await checkPlanPermission(
      read,
      { file_path: "/workspace/.env" },
      planContext(),
      [],
      [read],
      [],
    )

    expect(result).toBeNull()
  })

  test("filters secrets and explicit ask targets from Grep in an additional root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wren-plan-grep-"))
    const source = join(directory, "source.ts")
    const secret = join(directory, ".env")
    const privateFile = join(directory, "private.txt")
    writeFileSync(source, "needle")
    writeFileSync(secret, "needle")
    writeFileSync(privateFile, "needle")

    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      mode: "plan" as const,
      alwaysAskRules: { session: [`Read(/${privateFile})`] },
      additionalWorkingDirectories: new Map([
        [directory, { path: directory, source: "session" as const }],
      ]),
    }
    const context = {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: permissionContext }),
    } as unknown as ToolUseContext

    try {
      const result = await GrepTool.call(
        { pattern: "needle", path: directory, output_mode: "files_with_matches" },
        context,
      )

      expect(result.data.filenames).toContain(source)
      expect(result.data.filenames).not.toContain(secret)
      expect(result.data.filenames).not.toContain(privateFile)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("returns out-of-workspace absolute Glob patterns to normal permission handling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wren-plan-glob-"))

    try {
      const result = await checkPlanPermission(
        GlobTool,
        { pattern: join(directory, "**/*.ts"), path: process.cwd() },
        planContext(),
        [],
        [GlobTool],
        [],
      )

      expect(GlobTool.getPath({ pattern: join(directory, "**/*.ts"), path: process.cwd() })).toBe(
        directory,
      )
      expect(result).toBeNull()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("falls back when a Read tool itself requests permission", async () => {
    const read = fakeTool("Read", "ask")
    const result = await checkPlanPermission(
      read,
      { file_path: "/outside/file.ts" },
      planContext(),
      [],
      [read],
      [],
    )

    expect(result).toBeNull()
  })

  test("routes teammate ExitPlanMode through its mailbox-aware permission check", async () => {
    const teammateContext = {
      agentId: "worker@team",
      agentName: "worker",
      teamName: "team",
      planModeRequired: true,
      parentSessionId: "parent",
      isInProcess: true as const,
      abortController: new AbortController(),
    }
    const inheritedModeContext = planContext({ mode: "acceptEdits" })

    const result = await runWithTeammateContext(teammateContext, () =>
      checkPlanPermission(
        ExitPlanModeV2Tool,
        {},
        inheritedModeContext,
        [],
        [ExitPlanModeV2Tool],
        [],
      ),
    )

    expect(result?.behavior).toBe("allow")
  })

  test("enforces rules before guarded agent fallback", async () => {
    const agent = fakeTool("Agent")
    const denied = await checkPlanPermission(
      agent,
      { subagent_type: "general-purpose" },
      planContext({ alwaysDenyRules: { session: ["Agent"] } }),
      [],
      [agent],
      [],
    )
    const asking = await checkPlanPermission(
      agent,
      { subagent_type: "general-purpose" },
      planContext({ alwaysAskRules: { session: ["Agent"] } }),
      [],
      [agent],
      [],
    )

    expect(denied?.behavior).toBe("deny")
    expect(asking).toBeNull()
  })

  test("allows only built-in Explore and Plan agents", async () => {
    const agent = fakeTool("Agent")
    const context = planContext()

    const explore = await checkPlanPermission(
      agent,
      { subagent_type: "Explore" },
      context,
      [],
      [agent],
      [builtInAgent("Explore")],
    )
    const general = await checkPlanPermission(
      agent,
      { subagent_type: "general-purpose" },
      context,
      [],
      [agent],
      [],
    )
    const customExplore = await checkPlanPermission(
      agent,
      { subagent_type: "Explore" },
      context,
      [],
      [agent],
      [{ agentType: "Explore", source: "projectSettings" } as AgentDefinition],
    )

    expect(explore?.behavior).toBe("allow")
    expect(general).toBeNull()
    expect(customExplore).toBeNull()
  })
})

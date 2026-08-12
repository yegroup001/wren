import { describe, expect, test } from "bun:test"
import {
  AdapterPayloadError,
  parseCreateSessionBody,
  parsePermissionModeBody,
} from "./local-adapter-helpers"

describe("permission mode payloads", () => {
  test("defaults mode changes to automatic", () => {
    expect(parsePermissionModeBody({ permissionMode: "plan" })).toEqual({
      permissionMode: "plan",
      source: "automatic",
    })
  })

  test("accepts explicit manual mode changes", () => {
    expect(parsePermissionModeBody({ permissionMode: "plan", source: "manual" })).toEqual({
      permissionMode: "plan",
      source: "manual",
    })
  })

  test("rejects invalid mode change sources", () => {
    expect(() => parsePermissionModeBody({ permissionMode: "plan", source: "keyboard" })).toThrow(
      AdapterPayloadError,
    )
  })

  test("preserves the initial session mode source", () => {
    expect(
      parseCreateSessionBody({
        cwd: "/tmp/project",
        permissionMode: "plan",
        permissionModeSource: "manual",
      }),
    ).toMatchObject({
      permissionMode: "plan",
      permissionModeSource: "manual",
    })
  })
})

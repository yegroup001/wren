import { describe, expect, test } from "bun:test"
import { getSubprocessCmds, MAX_COPY_BYTES } from "./clipboard"

describe("MAX_COPY_BYTES", () => {
  test("is 1MB", () => {
    expect(MAX_COPY_BYTES).toBe(1024 * 1024)
  })
})

describe("getSubprocessCmds", () => {
  test("returns pbcopy on darwin", () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    expect(getSubprocessCmds()).toEqual(["pbcopy"])
    Object.defineProperty(process, "platform", { value: original, configurable: true })
  })

  test("returns xsel, wl-copy, xclip on linux", () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    const cmds = getSubprocessCmds()
    expect(cmds).toContain("xsel --clipboard --input")
    expect(cmds).toContain("wl-copy")
    expect(cmds).toContain("xclip -selection clipboard")
    Object.defineProperty(process, "platform", { value: original, configurable: true })
  })

  test("returns clip on win32", () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    expect(getSubprocessCmds()).toEqual(["clip"])
    Object.defineProperty(process, "platform", { value: original, configurable: true })
  })

  test("returns empty array on unknown platform", () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true })
    expect(getSubprocessCmds()).toEqual([])
    Object.defineProperty(process, "platform", { value: original, configurable: true })
  })
})

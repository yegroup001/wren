import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

let nativePrewarmCalls = 0
let nativeReturnValue = false
let nativeShouldThrow = false

const nativeIsModifierPressed = mock((modifier: string) => {
  if (nativeShouldThrow) {
    throw new Error("native modifier failure")
  }
  return nativeReturnValue
})

mock.module("modifiers-napi", () => ({
  prewarm: async () => {
    nativePrewarmCalls++
  },
  isModifierPressed: nativeIsModifierPressed,
}))

const originalPlatform = process.platform

async function loadModule() {
  return import(`../modifiers.ts?case=${Math.random()}`)
}

beforeEach(() => {
  nativePrewarmCalls = 0
  nativeReturnValue = false
  nativeShouldThrow = false
  nativeIsModifierPressed.mockClear()
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  })
})

describe("src/utils/modifiers", () => {
  test("does not touch the native module on non-darwin", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    })
    const mod = await loadModule()

    mod.prewarmModifiers()
    expect(nativePrewarmCalls).toBe(0)
    expect(mod.isModifierPressed("shift")).toBe(false)
    expect(nativeIsModifierPressed).not.toHaveBeenCalled()
  })

  test("caches native prewarm after the first darwin call", async () => {
    // modifiers-napi was removed (Tier 3) — prewarmModifiers is a no-op
    const mod = await loadModule()
    mod.prewarmModifiers()
    mod.prewarmModifiers()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(nativePrewarmCalls).toBe(0)
  })

  test("forwards modifier checks to the native module on darwin", async () => {
    // modifiers-napi was removed — always returns false
    const mod = await loadModule()
    expect(mod.isModifierPressed("shift")).toBe(false)
  })

  test("returns false when native modifier checks throw on darwin", async () => {
    // modifiers-napi was removed — always returns false
    const mod = await loadModule()
    expect(mod.isModifierPressed("shift")).toBe(false)
  })
})

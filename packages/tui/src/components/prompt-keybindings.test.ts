import { describe, expect, test } from "bun:test"
import { promptTextareaKeyBindings } from "./prompt-keybindings"

describe("promptTextareaKeyBindings", () => {
  test("has submit action for return key", () => {
    const submitBindings = promptTextareaKeyBindings.filter((b) => b.action === "submit")
    expect(submitBindings.length).toBeGreaterThan(0)
    expect(submitBindings.some((b) => b.name === "return")).toBe(true)
    expect(submitBindings.some((b) => b.name === "kpenter")).toBe(true)
    expect(submitBindings.some((b) => b.name === "linefeed")).toBe(true)
  })

  test("submit bindings have no modifiers", () => {
    const submitBindings = promptTextareaKeyBindings.filter((b) => b.action === "submit")
    for (const b of submitBindings) {
      expect(b.shift ?? false).toBe(false)
      expect(b.ctrl ?? false).toBe(false)
      expect(b.meta ?? false).toBe(false)
    }
  })

  test("has newline action for shift+return", () => {
    const newlineShift = promptTextareaKeyBindings.find(
      (b) => b.action === "newline" && b.name === "return" && b.shift === true,
    )
    expect(newlineShift).toBeDefined()
  })

  test("has newline action for ctrl+return", () => {
    const newlineCtrl = promptTextareaKeyBindings.find(
      (b) => b.action === "newline" && b.name === "return" && b.ctrl === true,
    )
    expect(newlineCtrl).toBeDefined()
  })

  test("has newline action for meta+return", () => {
    const newlineMeta = promptTextareaKeyBindings.find(
      (b) => b.action === "newline" && b.name === "return" && b.meta === true,
    )
    expect(newlineMeta).toBeDefined()
  })

  test("has newline action for ctrl+j", () => {
    const ctrlJ = promptTextareaKeyBindings.find(
      (b) => b.action === "newline" && b.name === "j" && b.ctrl === true,
    )
    expect(ctrlJ).toBeDefined()
  })

  test("every binding has a name and action", () => {
    for (const b of promptTextareaKeyBindings) {
      expect(typeof b.name).toBe("string")
      expect(b.name.length).toBeGreaterThan(0)
      expect(b.action).toMatch(/^(submit|newline)$/)
    }
  })
})

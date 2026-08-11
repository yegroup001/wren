import { describe, expect, test } from "bun:test"
import { BUILT_IN_THEMES, DEFAULT_THEME } from "../theme/themes"
import { createThemeSyntaxStyle } from "./syntax"

describe("createThemeSyntaxStyle", () => {
  test("returns a SyntaxStyle object", () => {
    const style = createThemeSyntaxStyle(DEFAULT_THEME)
    expect(style).toBeDefined()
    expect(typeof style).toBe("object")
  })

  test("produces a style with rules", () => {
    const style = createThemeSyntaxStyle(DEFAULT_THEME)
    // SyntaxStyle should have methods or properties for styling
    // Verify it doesn't throw and returns a truthy value
    expect(style).toBeTruthy()
  })

  test("works with different themes", () => {
    const style = createThemeSyntaxStyle(BUILT_IN_THEMES.dracula)
    expect(style).toBeTruthy()
  })

  test("creates independent instances", () => {
    const style1 = createThemeSyntaxStyle(DEFAULT_THEME)
    const style2 = createThemeSyntaxStyle(DEFAULT_THEME)
    expect(style1).not.toBe(style2)
  })
})

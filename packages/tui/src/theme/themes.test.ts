import { describe, expect, test } from "bun:test"
import { BUILT_IN_THEMES, DEFAULT_THEME, getTheme, THEME_NAMES, type TuiTheme } from "./themes"

const REQUIRED_KEYS: readonly (keyof TuiTheme)[] = [
  "primary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "tip",
  "text",
  "textDim",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "selectionBg",
  "selectionFg",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffHunkHeader",
  "markdownHeading",
  "markdownLink",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownListItem",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "user",
  "assistant",
  "thinking",
  "tool",
  "toolBash",
  "toolRead",
  "toolWrite",
  "toolWeb",
  "toolTodo",
  "toolAgent",
  "toolPlan",
  "toolDefault",
]

describe("BUILT_IN_THEMES", () => {
  test("includes all expected theme names", () => {
    expect(THEME_NAMES).toEqual(["wren", "dracula", "catppuccin", "nord", "tokyonight"])
  })

  test("every theme has all required keys", () => {
    for (const name of THEME_NAMES) {
      const theme = BUILT_IN_THEMES[name]
      for (const key of REQUIRED_KEYS) {
        expect(theme[key], `theme ${name} missing key ${key}`).toBeDefined()
        expect(typeof theme[key]).toBe("string")
        expect(theme[key]).toMatch(
          /^#[0-9a-fA-F]{6}$/,
          `${name}.${key} = ${theme[key]} is not a hex color`,
        )
      }
    }
  })

  test("every theme color is a valid 6-digit hex", () => {
    for (const name of THEME_NAMES) {
      const theme = BUILT_IN_THEMES[name]
      for (const key of REQUIRED_KEYS) {
        expect(theme[key]).toMatch(/^#[0-9a-fA-F]{6}$/, `${name}.${key}`)
      }
    }
  })
})

describe("DEFAULT_THEME", () => {
  test("is the wren theme", () => {
    expect(DEFAULT_THEME).toBe(BUILT_IN_THEMES.wren)
  })
})

describe("getTheme", () => {
  test("returns theme by name", () => {
    expect(getTheme("wren")).toBe(BUILT_IN_THEMES.wren)
    expect(getTheme("dracula")).toBe(BUILT_IN_THEMES.dracula)
    expect(getTheme("tokyonight")).toBe(BUILT_IN_THEMES.tokyonight)
  })

  test("returns undefined for unknown theme", () => {
    expect(getTheme("nonexistent")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(getTheme("")).toBeUndefined()
  })
})

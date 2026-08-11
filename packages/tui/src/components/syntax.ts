import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import type { TuiTheme } from "../theme/themes"
export function createThemeSyntaxStyle(theme: TuiTheme): SyntaxStyle {
  return SyntaxStyle.fromTheme(syntaxRules(theme))
}

function syntaxRules(theme: TuiTheme): ThemeTokenStyle[] {
  return [
    { scope: ["default"], style: { foreground: theme.text } },
    {
      scope: ["comment", "comment.documentation"],
      style: { foreground: theme.syntaxComment, italic: true },
    },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean", "constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword, italic: true } },
    {
      scope: ["keyword.function", "function", "function.method", "constructor"],
      style: { foreground: theme.syntaxFunction },
    },
    { scope: ["type", "class", "module"], style: { foreground: theme.syntaxType } },
    {
      scope: ["variable", "variable.parameter", "property", "parameter"],
      style: { foreground: theme.text },
    },
    {
      scope: ["operator", "punctuation", "punctuation.delimiter", "punctuation.bracket"],
      style: { foreground: theme.textMuted },
    },
    {
      scope: ["variable.builtin", "type.builtin", "function.builtin"],
      style: { foreground: theme.error },
    },
    {
      scope: ["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3"],
      style: { foreground: theme.markdownHeading, bold: true },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: { foreground: theme.markdownStrong, bold: true },
    },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    {
      scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"],
      style: { foreground: theme.markdownCode },
    },
    {
      scope: ["markup.link", "markup.link.url"],
      style: { foreground: theme.markdownLink, underline: true },
    },
    { scope: ["conceal"], style: { foreground: theme.textMuted } },
  ]
}

export function useSyntaxStyle(): Accessor<SyntaxStyle> {
  const { theme } = useTheme()
  const [style, setStyle] = createSignal(createThemeSyntaxStyle(theme()))
  let prev = style()
  createEffect(() => {
    const next = createThemeSyntaxStyle(theme())
    prev?.destroy()
    prev = next
    setStyle(next)
  })
  onCleanup(() => prev?.destroy())
  return style
}

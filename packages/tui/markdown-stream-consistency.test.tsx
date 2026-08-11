import { describe, expect, test } from "bun:test"
import type { MarkdownRenderable } from "@opentui/core"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"

const CASES = [
  "**bold** and *italic*",
  "**bo", // incomplete bold
  "[label](https://example.com) inline link",
  "# Heading\n\nSome **bold** text with `code`",
  "- item one\n- item two\n- item three",
  "## Section\n\n### Sub\n\nSome text here.",
  "```python\nprint('hello')\n```",
  "```py\nprint('hello')\n", // incomplete fence
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "> quote with **bold**",
]

function Demo(props: {
  content: string
  topLevel: boolean
  ref?: (el: MarkdownRenderable) => void
}): JSX.Element {
  const style = SyntaxStyle.create()
  return (
    <box width={80}>
      <markdown
        content={props.content}
        syntaxStyle={style}
        streaming={true}
        internalBlockMode={props.topLevel ? "top-level" : undefined}
        ref={props.ref}
      />
    </box>
  )
}

function buffers(el: MarkdownRenderable): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: debug introspection
  const anyEl = el as any
  const out: string[] = []
  for (const state of anyEl._blockStates ?? []) {
    const rb = state.renderable
    out.push(`${state.token?.type ?? "?"}[${rb?.plainText ?? ""}]`)
  }
  return out
}

// The TUI ships `internalBlockMode="top-level"`: in coalesced mode the
// synchronous inline-styled path and the async tree-sitter path render
// headings differently (`# Heading` vs `Heading`), so a streamed message
// alternates between the two renderings every token — visible flicker.
describe("buffer consistency", () => {
  for (const content of CASES) {
    test(`top-level ${JSON.stringify(content)}`, async () => {
      let el: MarkdownRenderable | undefined
      const setup = await testRender(
        () => <Demo content={content} topLevel={true} ref={(e) => (el = e)} />,
        { width: 80, height: 20 },
      )
      await setup.renderOnce()
      // biome-ignore lint/style/noNonNullAssertion: ref is set by the rendered element
      const sync = buffers(el!)

      // Let the async tree-sitter highlight complete and re-render.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await setup.renderOnce()
      // biome-ignore lint/style/noNonNullAssertion: ref is set by the rendered element
      const asyncState = buffers(el!)

      setup.renderer.destroy()
      expect(sync).toEqual(asyncState)
    })
  }
})

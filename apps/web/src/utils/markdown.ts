import hljs from "highlight.js/lib/common"
import { marked } from "marked"
import xss, { getDefaultWhiteList } from "xss"

marked.setOptions({ gfm: true, breaks: true })

const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => {
  const language = lang ?? ""
  const highlighted = highlightCode(text, language)
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`
}
marked.use({ renderer })

export function highlightCode(code: string, language: string): string {
  if (language !== "" && hljs.getLanguage(language) !== undefined) {
    try {
      return hljs.highlight(code, { language }).value
    } catch {
      // fall through to auto-detection
    }
  }
  try {
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  // Copy the default whitelist (xss may return a shared reference) and allow
  // highlight.js class attributes through.
  const whiteList: Record<string, string[]> = {}
  for (const [tag, attrs] of Object.entries(getDefaultWhiteList())) {
    whiteList[tag] = [...(attrs ?? [])]
  }
  for (const tag of ["code", "pre", "span", "table", "td", "th"]) {
    const attrs = whiteList[tag] ?? []
    whiteList[tag] = [...attrs, "class"]
  }
  return xss(html, { whiteList, stripIgnoreTag: true })
}

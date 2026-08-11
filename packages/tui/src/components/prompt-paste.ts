import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { PasteEvent, TextareaRenderable } from "@opentui/core"
import { onCleanup } from "solid-js"

export const PASTE_SUMMARY_LINES = 3
export const PASTE_SUMMARY_CHARS = 150
export const PASTE_PREVIEW_CHARS = 100
export const MAX_FILE_BYTES = 1048576 // 1MB

export function looksLikeFilePath(text: string): boolean {
  if (text.includes("\n")) return false
  // m13: Reject URLs (http://, https://, ftp://, ...) — file:// is allowed.
  // Require an explicit path prefix to avoid false positives like "example.com".
  if (text.includes("://") && !text.startsWith("file://")) return false
  return (
    text.startsWith("/") ||
    text.startsWith("~/") ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("file://")
  )
}

export function resolveFilePath(text: string): string {
  const raw = text.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return new URL(raw).pathname
    } catch {
      return raw
    }
  }
  if (raw.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/tmp", raw.slice(2))
  }
  return path.resolve(raw)
}

export function isBinaryContent(content: string): boolean {
  return content.includes("\0")
}

export function buildPreview(content: string): string {
  const flattened = content.replace(/\s+/g, " ").trim()
  if (flattened.length === 0) return ""
  if (flattened.length <= PASTE_PREVIEW_CHARS) return ` — ${flattened}`
  return ` — ${flattened.slice(0, PASTE_PREVIEW_CHARS)}…`
}

export type PasteHandlerDeps = {
  readonly getTextarea: () => TextareaRenderable | undefined
  readonly setPasteSummary: (value: string | undefined) => void
}

export function createPasteHandler(deps: PasteHandlerDeps): (event: PasteEvent) => Promise<void> {
  const timers: ReturnType<typeof setTimeout>[] = []
  onCleanup(() => {
    for (const t of timers) clearTimeout(t)
  })
  return async (event: PasteEvent) => {
    const text = Buffer.from(event.bytes)
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    if (looksLikeFilePath(trimmed)) {
      // C6: preventDefault must fire synchronously, before any await.
      // If we await readFile first, the default paste already fired and the
      // user sees both the raw path AND the [File: ...] label.
      event.preventDefault()
      try {
        const resolved = resolveFilePath(trimmed)

        // m12: check file size before reading to avoid memory exhaustion
        const stats = await stat(resolved)
        if (stats.size > MAX_FILE_BYTES) {
          const msg = `File too large (max 1MB): ${path.basename(resolved)}`
          deps.setPasteSummary(msg)
          timers.push(setTimeout(() => deps.setPasteSummary(undefined), 1500))
          return
        }

        const content = await readFile(resolved, "utf-8")
        if (isBinaryContent(content)) {
          // Binary file — insert original text since we already prevented default
          deps.getTextarea()?.insertText(text)
          return
        }

        const lineCount = content.split("\n").length
        const preview = buildPreview(content)
        const label = `[File: ${path.basename(resolved)} (~${lineCount} lines)${preview}]`
        deps.getTextarea()?.insertText(`${content} `)
        deps.setPasteSummary(label)
        timers.push(setTimeout(() => deps.setPasteSummary(undefined), 1500))
        return
      } catch {
        // Not a readable file — insert original text since we already prevented default
        deps.getTextarea()?.insertText(text)
        return
      }
    }

    const lineCount = (text.match(/\n/g)?.length ?? 0) + 1
    if (lineCount >= PASTE_SUMMARY_LINES || text.length > PASTE_SUMMARY_CHARS) {
      // Let the textarea handle the paste natively — it supports multi-line text.
      // No summary replacement, no pastedParts indirection.
      deps.setPasteSummary(`Pasted ${lineCount} lines`)
      timers.push(setTimeout(() => deps.setPasteSummary(undefined), 1500))
    }
  }
}

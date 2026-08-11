import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { useRenderer } from "@opentui/solid"

export type ExternalEditorResult = {
  readonly text: string
  readonly cancelled: boolean
}

export function useExternalEditor(): {
  open: (initialText: string) => Promise<ExternalEditorResult>
} {
  const renderer = useRenderer()

  async function open(initialText: string): Promise<ExternalEditorResult> {
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi"
    const dir = await mkdtemp(path.join(tmpdir(), "wren-edit-"))
    const filePath = path.join(dir, "prompt.md")

    try {
      await writeFile(filePath, initialText, "utf-8")

      renderer.suspend()

      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [filePath], {
          stdio: "inherit",
          env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
        })
        child.on("exit", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`${editor} exited with code ${code}`))
        })
        child.on("error", (err) => reject(err))
      })

      const text = await readFile(filePath, "utf-8")
      return { text, cancelled: false }
    } catch (err) {
      if (err instanceof Error && err.message.includes("exited")) {
        return { text: initialText, cancelled: true }
      }
      throw err
    } finally {
      renderer.resume()
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { open }
}

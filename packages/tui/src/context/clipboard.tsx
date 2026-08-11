import type { JSX, ParentProps } from "solid-js"
import { createSimpleContext } from "./helper"

export type ClipboardContext = {
  readonly copy: (text: string) => Promise<void>
  readonly paste: () => Promise<string>
}

export const MAX_COPY_BYTES = 1024 * 1024
const OSC52_CHUNK_SIZE = 1000

type CopyMethod = "osc52" | "subprocess"
let cachedCopyMethod: CopyMethod | undefined
let cachedSubprocessCmd: string | undefined

function copyViaOSC52(text: string): boolean {
  try {
    const base64 = Buffer.from(text, "utf8").toString("base64")
    process.stdout.write("\x1b]52;c;")
    for (let i = 0; i < base64.length; i += OSC52_CHUNK_SIZE) {
      process.stdout.write(base64.slice(i, i + OSC52_CHUNK_SIZE))
    }
    process.stdout.write("\x07")
    return true
  } catch {
    return false
  }
}

async function execWrite(cmd: string, input: string): Promise<void> {
  const { exec } = await import("node:child_process")
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, (err) => (err ? reject(err) : resolve()))
    proc.stdin?.write(input)
    proc.stdin?.end()
  })
}

export function getSubprocessCmds(): string[] {
  const platform = process.platform
  if (platform === "darwin") return ["pbcopy"]
  if (platform === "linux")
    return ["xsel --clipboard --input", "wl-copy", "xclip -selection clipboard"]
  if (platform === "win32") return ["clip"]
  return []
}

async function trySubprocessCopy(text: string): Promise<boolean> {
  const cmds = getSubprocessCmds()
  for (const cmd of cmds) {
    try {
      await execWrite(cmd, text)
      cachedSubprocessCmd = cmd
      return true
    } catch {
      // Try next clipboard command
    }
  }
  return false
}

async function pasteViaSubprocess(): Promise<string> {
  const platform = process.platform
  if (platform === "darwin") {
    const { exec } = await import("node:child_process")
    return new Promise((resolve, reject) => {
      exec("pbpaste", (err, stdout) => (err ? reject(err) : resolve(stdout)))
    })
  }
  if (platform === "linux") {
    const { exec } = await import("node:child_process")
    const cmds = ["xsel --clipboard --output", "wl-paste", "xclip -selection clipboard -o"]
    for (const cmd of cmds) {
      try {
        return await new Promise<string>((resolve, reject) => {
          exec(cmd, (err, stdout) => (err ? reject(err) : resolve(stdout)))
        })
      } catch {
        // Try next clipboard command
      }
    }
    return ""
  }
  if (platform === "win32") {
    const { exec } = await import("node:child_process")
    return new Promise((resolve, reject) => {
      exec("powershell -command Get-Clipboard", (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      )
    })
  }
  return ""
}

async function copyWithFallback(text: string): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_COPY_BYTES) {
    throw new Error("Content too large to copy")
  }

  if (cachedCopyMethod === "subprocess" && cachedSubprocessCmd) {
    await execWrite(cachedSubprocessCmd, text)
    return
  }
  if (cachedCopyMethod === "osc52") {
    if (!copyViaOSC52(text)) throw new Error("Clipboard copy failed")
    return
  }

  if (await trySubprocessCopy(text)) {
    cachedCopyMethod = "subprocess"
    return
  }
  cachedCopyMethod = "osc52"
  if (!copyViaOSC52(text)) {
    throw new Error("Clipboard copy failed")
  }
}

const { use, provider } = createSimpleContext<ClipboardContext>({
  name: "Clipboard",
  init: () => ({
    copy: (text: string) =>
      copyWithFallback(text).catch((err) => {
        if (err instanceof Error && err.message === "Content too large to copy") {
          console.warn(err.message)
        }
        // Other errors (subprocess failures, OSC52 errors) are non-fatal
      }),
    paste: () => pasteViaSubprocess().catch(() => ""),
  }),
})

export const useClipboard = use

export function ClipboardProvider(props: ParentProps): JSX.Element {
  return provider(props)
}

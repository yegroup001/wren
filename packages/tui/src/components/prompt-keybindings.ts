import type { TextareaOptions } from "@opentui/core"

type PromptTextareaKeyBinding = NonNullable<TextareaOptions["keyBindings"]>[number]

export const promptTextareaKeyBindings: PromptTextareaKeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "kpenter", ctrl: true, action: "newline" },
  { name: "linefeed", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
  { name: "linefeed", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
]

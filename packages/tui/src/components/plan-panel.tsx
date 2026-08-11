/** @jsxImportSource @opentui/solid */

import type { Message } from "@wren/protocol"
import { createMemo, type JSX, Show } from "solid-js"
import { useStore } from "../context/store"
import { useTheme } from "../context/theme"

export function PlanPanel(props: { sessionId: string }): JSX.Element {
  const store = useStore()
  const { theme } = useTheme()

  const messages = createMemo<Message[]>(() => store.store.messages[props.sessionId] ?? [])
  const lastAssistant = createMemo(() => {
    for (let i = messages().length - 1; i >= 0; i--) {
      if (messages()[i]?.role === "assistant") return messages()[i]
    }
    return undefined
  })

  const planText = createMemo(() => {
    const msg = lastAssistant()
    if (msg === undefined) return ""
    return msg.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
      .trim()
  })

  return (
    <Show when={planText().length > 0}>
      <text fg={theme().text} wrapMode="word">
        {planText()}
      </text>
    </Show>
  )
}

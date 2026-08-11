/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import type { Message, Part } from "@wren/protocol"
import { parseMessageId, parsePartId } from "@wren/protocol"
import { createMemo, For, type JSX } from "solid-js"
import { MessageView, formatTimestamp } from "./transcript"

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown }

interface EngineMessage {
  type: string
  message?: {
    role?: string
    content?: ContentBlock[] | string
  }
  uuid: string
  timestamp?: string
}

function contentBlockToPart(block: ContentBlock, uuid: string, index: number): Part {
  switch (block.type) {
    case "text":
      return { type: "text", id: parsePartId(`part_sa_${uuid}_${index}`), text: block.text }
    case "thinking":
      return {
        type: "thinking",
        id: parsePartId(`part_sa_${uuid}_${index}`),
        text: block.thinking,
        signature: block.signature,
      }
    case "tool_use":
      return {
        type: "tool_use",
        id: parsePartId(`part_sa_${uuid}_${index}`),
        toolName: block.name,
        input: block.input,
        status: "completed",
      }
    case "tool_result":
      return {
        type: "tool_result",
        id: parsePartId(`part_sa_${uuid}_${index}`),
        toolUseId: block.tool_use_id,
        content: block.content,
      }
  }
}

function extractParts(msg: EngineMessage): Part[] {
  const content = msg.message?.content
  if (typeof content === "string") {
    return [{ type: "text", id: parsePartId(`part_sa_${msg.uuid}_0`), text: content }]
  }
  if (!Array.isArray(content)) return []
  return content.map((block, i) => contentBlockToPart(block, msg.uuid, i))
}

function toMessage(msg: EngineMessage, index: number): Message {
  const role = msg.message?.role ?? "unknown"
  return {
    id: parseMessageId(`msg_sa_${msg.uuid}_${index}`),
    sessionId: "" as never,
    role: role as Message["role"],
    parts: extractParts(msg),
    createdAt: msg.timestamp ?? new Date(0).toISOString(),
  }
}

export function SubagentTranscriptView(props: {
  messages: unknown[]
  sessionId: string
  agentActive?: boolean
}): JSX.Element {
  const parsed = createMemo(() => {
    return (props.messages as EngineMessage[])
      .filter(
        (msg) => msg?.message?.role !== undefined || typeof msg?.message?.content === "string",
      )
      .map((msg, i) => toMessage(msg, i))
      .filter((m) => m.parts.length > 0)
  })

  // While the subagent is still running, the last assistant message is live:
  // its thinking part must read "Thinking" (with an elapsed timer), not
  // "Thought". Completed transcripts stay fully static.
  const lastAssistantIndex = createMemo(() => {
    const list = parsed()
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.role === "assistant") return i
    }
    return -1
  })

  let scrollRef: ScrollBoxRenderable | undefined
  const scrollByPage = (direction: -1 | 1): void => {
    if (scrollRef) scrollRef.scrollBy(direction * Math.floor(scrollRef.height))
  }

  useKeyboard((key) => {
    if (!scrollRef) return
    const name = key.name
    if (key.ctrl && (name === "u" || name === "b")) {
      key.preventDefault()
      key.stopPropagation()
      scrollByPage(-1)
      return
    }
    if (key.ctrl && name === "d") {
      key.preventDefault()
      key.stopPropagation()
      scrollByPage(1)
      return
    }
    if (name === "pageup") {
      key.preventDefault()
      key.stopPropagation()
      scrollByPage(-1)
      return
    }
    if (name === "pagedown") {
      key.preventDefault()
      key.stopPropagation()
      scrollByPage(1)
      return
    }
    if ((key.ctrl && name === "g") || name === "home") {
      key.preventDefault()
      key.stopPropagation()
      scrollRef.scrollTo(0)
      return
    }
    if (name === "end") {
      key.preventDefault()
      key.stopPropagation()
      scrollRef.scrollTo(scrollRef.scrollHeight)
    }
  })

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => {
        scrollRef = r
      }}
      flexGrow={1}
      minHeight={0}
      paddingRight={1}
      stickyScroll
      stickyStart="bottom"
      focused={false}
      verticalScrollbarOptions={{ visible: true }}
    >
      <box height={1} />
      <For each={parsed()}>
        {(message, index) => (
          <MessageView
            message={message}
            sessionId={props.sessionId}
            isStreaming={props.agentActive === true && index() === lastAssistantIndex()}
            prevTimestamp={
              index() > 0
                ? formatTimestamp(parsed()[index() - 1]?.createdAt ?? "")
                : undefined
            }
          />
        )}
      </For>
    </scrollbox>
  )
}

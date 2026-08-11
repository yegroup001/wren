import type { ScrollBoxRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { type CompactProgress, createWrenRequest } from "@wren/adapter"
import { type Message, type Part, parsePartId } from "@wren/protocol"
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  onCleanup,
  Show,
} from "solid-js"
import { useClipboard } from "../context/clipboard"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useThinking } from "../context/thinking"
import { useToast } from "../ui/toast"
import { useSyntaxStyle } from "./syntax"
import { ToolCallView, ToolResultView } from "./tool-call"

type TextPart = Extract<Part, { type: "text" }>
type ThinkingPart = Extract<Part, { type: "thinking" }>

const INITIAL_VISIBLE_MESSAGES = 200
const LOAD_MORE_BATCH = 100

export function Transcript(props: {
  sessionId: string
  modalActive?: () => boolean
  scrollToBottomTick?: number
  onEditMessage?: (text: string, messageId: string) => void
  loading?: boolean
}): JSX.Element {
  const store = useStore()
  const { theme } = useTheme()
  const allMessages = createMemo<Message[]>(() => store.store.messages[props.sessionId] ?? [])
  const [visibleCount, setVisibleCount] = createSignal(INITIAL_VISIBLE_MESSAGES)
  const messages = createMemo<Message[]>(() => {
    const all = allMessages()
    if (all.length <= visibleCount()) return all
    return all.slice(-visibleCount())
  })
  const messageIds = createMemo(() => transcriptMessageIds(messages()))
  const hiddenCount = createMemo(() => allMessages().length - messages().length)
  createEffect(() => {
    props.sessionId
    setVisibleCount(INITIAL_VISIBLE_MESSAGES)
  })
  const status = createMemo(() => store.store.status[props.sessionId] ?? { type: "idle" as const })
  const compactProgress = createMemo(() => store.store.compactProgress[props.sessionId])
  const activeAssistantId = createMemo(() => {
    if (status().type !== "working") return undefined
    const all = allMessages()
    // The active turn spans from the last non-queued user message to the
    // end. Queued user messages are not turn boundaries: they either sit
    // after the streaming assistant (user queued input mid-turn) or before
    // a newly started assistant turn. So find the last non-queued user
    // message first, then scan backwards from the end of that range for the
    // newest error-free assistant message. Scanning past a queued user and
    // re-recording an earlier assistant would return a stale message id
    // (a completed prior turn's thinking would then read "Thought" while
    // the current turn is still thinking).
    let boundary = -1
    for (let i = all.length - 1; i >= 0; i--) {
      const msg = all[i]!
      if (msg.role === "user" && msg.queued !== true) {
        boundary = i
        break
      }
    }
    for (let i = all.length - 1; i > boundary; i--) {
      const msg = all[i]!
      if (msg.role === "assistant" && msg.error === undefined) return msg.id
    }
    return undefined
  })
  const [userScrolledUp, setUserScrolledUp] = createSignal(false)

  let scrollRef: ScrollBoxRenderable | undefined
  const handleScrollChange = (): void => {
    if (!scrollRef) return
    if (scrollRef.scrollTop <= 1 && hiddenCount() > 0) {
      const oldHeight = scrollRef.scrollHeight
      setVisibleCount((c) => c + LOAD_MORE_BATCH)
      requestAnimationFrame(() => {
        if (!scrollRef) return
        const diff = scrollRef.scrollHeight - oldHeight
        if (diff > 0) scrollRef.scrollTo(scrollRef.scrollTop + diff)
      })
    }
    const nearBottom = scrollRef.scrollTop + scrollRef.height >= scrollRef.scrollHeight - 2
    setUserScrolledUp(!nearBottom)
  }

  useKeyboard((key) => {
    if (props.modalActive?.()) return
    if (!scrollRef) return
    const name = key.name
    if (key.ctrl && (name === "u" || name === "b")) {
      key.preventDefault()
      key.stopPropagation()
      scrollRef.scrollBy(-Math.floor(scrollRef.height / 2))
      return
    }
    if (key.ctrl && name === "d") {
      key.preventDefault()
      key.stopPropagation()
      scrollRef.scrollBy(Math.floor(scrollRef.height / 2))
      return
    }
    if (name === "pageup") {
      key.preventDefault()
      key.stopPropagation()
      scrollRef.scrollBy(-scrollRef.height)
      return
    }
    if (name === "pagedown") {
      key.preventDefault()
      key.stopPropagation()
      scrollRef.scrollBy(scrollRef.height)
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
      return
    }
  })

  createEffect(() => {
    if (!scrollRef) return
    scrollRef.stickyScroll = !userScrolledUp()
  })

  createEffect(() => {
    const tick = props.scrollToBottomTick
    if (tick === undefined || tick === 0 || !scrollRef) return
    setUserScrolledUp(false)
    scrollRef.scrollTo(scrollRef.scrollHeight)
  })

  onCleanup(() => {
    scrollRef?.verticalScrollBar.off("change", handleScrollChange)
  })

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => {
        scrollRef = r
        r.verticalScrollBar.on("change", handleScrollChange)
      }}
      flexGrow={1}
      minHeight={0}
      paddingRight={1}
      stickyScroll
      stickyStart="bottom"
      focused={false}
      verticalScrollbarOptions={{ visible: true }}
    >
      <Show
        when={messages().length > 0 || compactProgress() !== undefined}
        fallback={
          <box paddingLeft={3} paddingTop={1}>
            <text fg={theme().textMuted}>
              {props.loading ? "Loading session..." : "Start a conversation..."}
            </text>
          </box>
        }
      >
        <box height={1} />
        <Show when={hiddenCount() > 0}>
          <box paddingLeft={3} paddingTop={1}>
            <text
              fg={theme().textMuted}
            >{`${hiddenCount()} earlier messages — scroll up to load more`}</text>
          </box>
        </Show>
        <For each={messageIds()}>
          {(messageId, index) => (
            <TranscriptMessageRow
              messageId={messageId}
              message={() => messages()[index()]}
              previousMessage={() =>
                index() > 0 ? messages()[index() - 1] : undefined
              }
              sessionId={props.sessionId}
              isStreaming={() => messageId === activeAssistantId()}
              modalActive={props.modalActive}
              onEditMessage={props.onEditMessage}
            />
          )}
        </For>
        <CompactProgressView progress={compactProgress} sessionId={props.sessionId} />
      </Show>
    </scrollbox>
  )
}

function TranscriptMessageRow(props: {
  messageId: Message["id"]
  message: Accessor<Message | undefined>
  previousMessage: Accessor<Message | undefined>
  sessionId: string
  isStreaming: Accessor<boolean>
  modalActive?: () => boolean
  onEditMessage?: (text: string, messageId: string) => void
}): JSX.Element {
  return (
    <Show when={props.message()}>
      {(message) => (
        <MessageView
          message={message()}
          sessionId={props.sessionId}
          isStreaming={props.isStreaming()}
          modalActive={props.modalActive}
          onEditMessage={props.onEditMessage}
          prevTimestamp={
            props.previousMessage() === undefined
              ? undefined
              : formatTimestamp(props.previousMessage()?.createdAt ?? "")
          }
        />
      )}
    </Show>
  )
}

export function transcriptMessageIds(messages: readonly Message[]): Message["id"][] {
  return messages.map((message) => message.id)
}

export function MessageView(props: {
  message: Message
  sessionId: string
  isStreaming: boolean
  modalActive?: () => boolean
  onEditMessage?: (text: string, messageId: string) => void
  prevTimestamp?: string
}): JSX.Element {
  const { theme } = useTheme()
  switch (props.message.role) {
    case "user":
      return (
        <UserMessageView
          message={props.message}
          modalActive={props.modalActive}
          onEditMessage={props.onEditMessage}
        />
      )
    case "assistant":
      return (
        <AssistantMessageView
          message={props.message}
          sessionId={props.sessionId}
          isStreaming={props.isStreaming}
          prevTimestamp={props.prevTimestamp}
        />
      )
    case "system":
      return <SystemMessageView message={props.message} />
    default: {
      // Unknown role from a newer server — render dimmed instead of crashing.
      const unknownRole = (props.message as { role?: string }).role
      return (
        <box paddingLeft={3} paddingTop={1}>
          <text fg={theme().textMuted}>{`[unknown message role: ${unknownRole ?? "?"}]`}</text>
        </box>
      )
    }
  }
}

function CompactProgressView(props: {
  progress: Accessor<CompactProgress | undefined>
  sessionId: string
}): JSX.Element {
  const { theme } = useTheme()
  const progress = createMemo(() => props.progress())
  const parts = createMemo<Part[]>(() => {
    const value = progress()
    if (value === undefined) return []
    return value.segments.map((segment, index) =>
      segment.type === "text"
        ? { type: "text", id: parsePartId(`compact_progress_text_${index}`), text: segment.text }
        : {
            type: "thinking",
            id: parsePartId(`compact_progress_thinking_${index}`),
            text: segment.text,
          },
    )
  })
  const lastPartIndex = createMemo(() => parts().length - 1)
  return (
    <Show when={progress() !== undefined}>
      <box flexDirection="column" marginTop={1}>
        <box paddingLeft={3}>
          <text fg={theme().assistant} flexShrink={0}>
            {"● Compaction"}
          </text>
        </box>
        <Index each={parts()}>
          {(part, index) => (
            <PartView
              part={part()}
              sessionId={props.sessionId}
              streaming={progress()?.phase !== "finalizing" && index === lastPartIndex()}
              skipToolResultIds={new Set()}
            />
          )}
        </Index>
        <Show when={parts().length === 0}>
          <box paddingLeft={3} marginTop={1}>
            <text fg={theme().textMuted}>{"…"}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function UserMessageView(props: {
  message: Message
  modalActive?: () => boolean
  onEditMessage?: (text: string, messageId: string) => void
}): JSX.Element {
  const { theme } = useTheme()
  const clipboard = useClipboard()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [menuIndex, setMenuIndex] = createSignal(0)
  const text = createMemo(() =>
    props.message.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n\n"),
  )
  const parsedSummary = createMemo(() => parseCompactSummaryText(text()))

  type MenuAction = { readonly label: string; readonly run: () => void }
  const menuActions = (): readonly MenuAction[] => [
    {
      label: "Edit & resend",
      run: () => {
        props.onEditMessage?.(text(), props.message.id)
        setMenuOpen(false)
      },
    },
    {
      label: "Copy",
      run: () => {
        void clipboard.copy(text())
        setMenuOpen(false)
      },
    },
    { label: "Close", run: () => setMenuOpen(false) },
  ]

  const toggleMenu = (): void => {
    if (props.modalActive?.()) return
    if (parsedSummary() !== null) return
    setMenuOpen((open) => !open)
  }

  createEffect(() => {
    if (props.modalActive?.()) setMenuOpen(false)
  })

  useKeyboard((key) => {
    if (props.modalActive?.() || !menuOpen()) return
    const name = key.name
    if (name === "up") {
      setMenuIndex((i) => (i - 1 + menuActions().length) % menuActions().length)
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (name === "down") {
      setMenuIndex((i) => (i + 1) % menuActions().length)
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (name === "return") {
      menuActions()[menuIndex()]?.run()
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (name === "escape") {
      setMenuOpen(false)
      key.preventDefault()
      key.stopPropagation()
      return
    }
  })

  return (
    <Show when={text().trim()}>
      <box
        border={["left"]}
        borderColor={props.message.queued ? theme().textMuted : theme().user}
        backgroundColor={theme().backgroundElement}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={3}
        marginTop={1}
        onMouseUp={toggleMenu}
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme().user} flexShrink={0}>
            {"You"}
          </text>
          <Show when={props.message.queued}>
            <text fg={theme().textMuted} attributes={TextAttributes.BOLD}>
              {"QUEUED"}
            </text>
          </Show>
        </box>
        <Show
          when={parsedSummary()}
          fallback={
            <text fg={theme().text} wrapMode="word">
              {text()}
            </text>
          }
        >
          {(parsed) => (
            <CompactSummaryContent notification={parsed().notification} summary={parsed().summary} />
          )}
        </Show>
        <Show when={menuOpen()}>
          <box flexDirection="column" gap={0} paddingTop={1} paddingLeft={0}>
            <For each={menuActions()}>
              {(act, idx) => (
                <box
                  paddingLeft={1}
                  paddingRight={2}
                  backgroundColor={
                    idx() === menuIndex() ? theme().selectionBg : theme().backgroundElement
                  }
                  onMouseUp={(e) => {
                    e?.stopPropagation?.()
                    act.run()
                  }}
                >
                  <text fg={idx() === menuIndex() ? theme().selectionFg : theme().textMuted}>
                    {act.label}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function AssistantMessageView(props: {
  message: Message
  sessionId: string
  isStreaming: boolean
  prevTimestamp?: string
}): JSX.Element {
  const { theme } = useTheme()
  const adapter = useAdapter()
  const toast = useToast()
  const hasError = createMemo(() => props.message.error !== undefined)
  const isStreamingMessage = createMemo(() => props.isStreaming)
  const [retryHover, setRetryHover] = createSignal(false)
  const [retrying, setRetrying] = createSignal(false)
  const time = createMemo(() => {
    const t = formatTimestamp(props.message.createdAt)
    return t !== "" && t === props.prevTimestamp ? "" : t
  })
  const lastPartIndex = createMemo(() => {
    const parts = props.message.parts
    for (let i = parts.length - 1; i >= 0; i--) {
      // biome-ignore lint/style/noNonNullAssertion: index in range
      const p = parts[i]!
      if (p.type === "tool_result") continue
      if (p.type === "text" && p.text.trim().length > 0) return i
      if (p.type === "thinking" && p.text.trim().length > 0) return i
      if (p.type === "tool_use") return i
    }
    return -1
  })
  const toolUseIds = createMemo(() => {
    const ids = new Set<string>()
    for (const part of props.message.parts) {
      if (part.type === "tool_use") ids.add(part.id)
    }
    return ids
  })

  return (
    <box flexDirection="column" marginTop={1}>
      <Show when={time() !== "" || props.prevTimestamp === undefined}>
        <box paddingLeft={3}>
          <text
            fg={theme().assistant}
            flexShrink={0}
          >{`${time() ? `[${time()}] ` : ""}\u25cf Wren`}</text>
        </box>
      </Show>
      <For each={props.message.parts}>
        {(part, index) => (
          <Show when={!(part.type === "text" && hasError() && part.text === props.message.error)}>
            <PartView
              part={part}
              sessionId={props.sessionId}
              streaming={isStreamingMessage() && index() === lastPartIndex()}
              skipToolResultIds={toolUseIds()}
            />
          </Show>
        )}
      </For>
      <Show when={props.message.compactSummary !== undefined}>
        <CompactSummaryContent
          notification=""
          summary={props.message.compactSummary?.summary ?? ""}
        />
      </Show>
      <Show when={hasError()}>
        <box border={["left"]} borderColor={theme().error} paddingLeft={3} marginTop={1}>
          <text fg={theme().error} wrapMode="word">
            {props.message.error}
          </text>
          <Show when={!retrying()}>
            <box
              flexDirection="row"
              marginTop={1}
              onMouseOver={() => setRetryHover(true)}
              onMouseOut={() => setRetryHover(false)}
              onMouseUp={() => {
                setRetrying(true)
                void adapter
                  .fetch(createWrenRequest(`/session/${props.sessionId}/retry`, { method: "POST" }))
                  .then(async (response) => {
                    if (!response.ok) {
                      const body = await response.json().catch(() => null)
                      const msg = body?.message ?? `Retry failed (${response.status})`
                      toast.show({ title: "Retry", message: msg, variant: "error" })
                    }
                  })
                  .catch(() => {
                    toast.show({ title: "Retry", message: "Network error", variant: "error" })
                  })
                  .finally(() => setRetrying(false))
              }}
            >
              <text fg={retryHover() ? theme().text : theme().textMuted}>{"[Retry]"}</text>
            </box>
          </Show>
          <Show when={retrying()}>
            <text fg={theme().textMuted} marginTop={1}>
              {"Retrying..."}
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

function SystemMessageView(props: { message: Message }): JSX.Element {
  const { theme } = useTheme()
  const text = createMemo(() =>
    props.message.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n\n"),
  )
  return (
    <Show when={text().trim()}>
      <box border={["left"]} borderColor={theme().info} paddingLeft={3} marginTop={1}>
        <text fg={theme().info} flexShrink={0}>
          {"[system]"}
        </text>
        <text fg={theme().textMuted} wrapMode="word">
          {text()}
        </text>
      </box>
    </Show>
  )
}

export function parseCompactSummaryText(
  text: string,
): { notification: string; summary: string } | null {
  const m = text.match(/^([\s\S]*?)<compact-summary>([\s\S]*?)<\/compact-summary>/)
  return m ? { notification: (m[1] ?? "").trim(), summary: (m[2] ?? "").trim() } : null
}

function CompactSummaryView(props: { part: TextPart }): JSX.Element {
  const parsed = createMemo(() => parseCompactSummaryText(props.part.text))

  return (
    <Show when={parsed()}>
      {(value) => (
        <CompactSummaryContent
          notification={value().notification}
          summary={value().summary}
          part={{ ...props.part, text: value().notification }}
        />
      )}
    </Show>
  )
}

function CompactSummaryContent(props: {
  notification: string
  summary: string
  part?: TextPart
}): JSX.Element {
  const { theme } = useTheme()
  const syntax = useSyntaxStyle()
  const [expanded, setExpanded] = createSignal(false)
  const toggle = (): void => {
    setExpanded((prev) => !prev)
  }

  return (
    <box flexDirection="column">
      <Show when={props.notification}>
        <TextPartView
          part={
            props.part ?? {
              type: "text",
              id: parsePartId("compact_summary_notification"),
              text: props.notification,
            }
          }
          streaming={false}
        />
      </Show>
      <box paddingLeft={3} marginTop={1} flexDirection="column">
        <box onMouseUp={toggle}>
          <text fg={theme().thinking} wrapMode="none">
            {`${expanded() ? "\u25be" : "\u25b8"} Compaction Summary`}
          </text>
        </box>
        <Show when={expanded()}>
          <box paddingLeft={1} marginTop={1}>
            <markdown
              content={props.summary}
              syntaxStyle={syntax()}
              fg={theme().textDim}
              streaming={true}
              internalBlockMode="top-level"
            />
          </box>
        </Show>
      </box>
    </box>
  )
}

function PartView(props: {
  part: Part
  streaming: boolean
  skipToolResultIds: Set<string>
  sessionId: string
}): JSX.Element {
  const { theme } = useTheme()
  switch (props.part.type) {
    case "text":
      if (props.part.text.includes("<compact-summary>")) {
        return <CompactSummaryView part={props.part} />
      }
      return <TextPartView part={props.part} streaming={props.streaming} />
    case "thinking":
      return <ThinkingPartView part={props.part} streaming={props.streaming} />
    case "tool_use":
      return <ToolCallView part={props.part} sessionId={props.sessionId} />
    case "tool_result":
      if (props.skipToolResultIds.has(`part_tool_${props.part.toolUseId}`)) return null
      return <ToolResultView part={props.part} />
    default: {
      // Unknown part type from a newer server — render dimmed instead of crashing.
      const unknownType = (props.part as { type?: string }).type
      return (
        <box paddingLeft={3} paddingTop={1}>
          <text fg={theme().textMuted}>{`[unknown part type: ${unknownType ?? "?"}]`}</text>
        </box>
      )
    }
  }
}

export function hasMarkdownSyntax(text: string): boolean {
  // Block-level patterns must appear at the start of a line
  if (/^(#{1,6}\s|>\s|-\s|\*\s|\d+\.\s|```)/m.test(text)) return true
  // Inline patterns can appear anywhere in the text
  return /\*\*|__(?=\w)|\[.*\]\(|`[^`]+`|\|/.test(text)
}

export function TextPartView(props: { part: TextPart; streaming: boolean }): JSX.Element {
  const { theme } = useTheme()
  const syntax = useSyntaxStyle()
  const text = createMemo(() => props.part.text.trim())
  const [markdownLatched, setMarkdownLatched] = createSignal(false)
  const isMarkdown = createMemo(() => {
    if (markdownLatched()) return true
    const detected = hasMarkdownSyntax(text())
    if (detected) setMarkdownLatched(true)
    return detected
  })

  return (
    <Show when={text().length > 0} fallback={<text fg={theme().textMuted}>{"\u2026"}</text>}>
      <box paddingLeft={3} marginTop={1}>
        <Show
          when={isMarkdown()}
          fallback={
            <text fg={theme().text} wrapMode="word">
              {props.streaming ? `${text()}\u2588` : text()}
            </text>
          }
        >
          <markdown
            content={text()}
            syntaxStyle={syntax()}
            fg={theme().text}
            // Keep streaming=true at rest too: flipping it to false forces a
            // full block rebuild with drawUnstyledText=false, blanking the
            // message until the async tree-sitter worker finishes (flicker).
            // OpenTUI's streaming mode only re-parses the unstable tail on
            // content change, so a static message costs nothing extra.
            streaming={true}
            internalBlockMode="top-level"
          />
        </Show>
      </box>
    </Show>
  )
}

export function ThinkingPartView(props: { part: ThinkingPart; streaming: boolean }): JSX.Element {
  const { theme } = useTheme()
  const syntax = useSyntaxStyle()
  const thinking = useThinking()
  const [expanded, setExpanded] = createSignal(thinking.mode() === "expanded")
  createEffect(() => {
    const mode = thinking.mode()
    setExpanded(mode === "expanded")
  })
  const [elapsed, setElapsed] = createSignal(0)
  const content = createMemo(() => props.part.text.trim())
  const title = createMemo(() => (props.streaming ? "Thinking" : "Thought"))
  const summary = createMemo(() => thinkingSummary(content()))

  let timer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (props.streaming) {
      const startTime = Date.now()
      setElapsed(0)
      timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000)
    }
  })
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  const toggle = (): void => {
    setExpanded((prev) => !prev)
  }

  const durationLabel = createMemo(() => {
    const secs = elapsed()
    if (secs === 0) return ""
    if (secs < 60) return `${secs}s`
    const mins = Math.floor(secs / 60)
    const rem = secs % 60
    return `${mins}m${rem}s`
  })

  return (
    <Show when={content().length > 0}>
      <box paddingLeft={3} marginTop={1} flexDirection="column">
        <box onMouseUp={toggle}>
          <text fg={theme().thinking} wrapMode="none">
            {`${expanded() ? "\u25be " : "\u25b8 "}${title()}${summary() ? `: ${summary()}` : ""}${durationLabel() ? ` (${durationLabel()})` : ""}`}
          </text>
        </box>
        <Show when={expanded() && content()}>
          <box paddingLeft={1} marginTop={1}>
            <markdown
              content={content()}
              syntaxStyle={syntax()}
              fg={theme().textDim}
              streaming={true}
              internalBlockMode="top-level"
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

export function thinkingSummary(text: string): string {
  // Bound the scan: the summary only ever shows the first line, and this
  // runs per streamed token — splitting the full text would be O(n) per
  // token on long thinking blocks.
  const firstLine = text.slice(0, 1024).split("\n")[0]?.trim() ?? ""
  const plain = firstLine
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(`{1,3}|\*{1,3}|_{1,3}|~~)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim()

  if (plain.length <= 60) return plain
  return `${plain.slice(0, 57).trimEnd()}...`
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  return `${h}:${m}`
}

import type { KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import type { PermissionRequest } from "@wren/protocol"
import { createEffect, createMemo, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { useToast } from "../ui/toast"

type PermissionReply = "once" | "session" | "deny"
type OptionKey = "once" | "always" | "reject"

export const OPTIONS: readonly { readonly key: OptionKey; readonly label: string }[] = [
  { key: "once", label: "Allow once" },
  { key: "always", label: "Allow always" },
  { key: "reject", label: "Reject" },
]

export const REPLY_MAP: Readonly<Record<OptionKey, PermissionReply>> = {
  once: "once",
  always: "session",
  reject: "deny",
}

/** Safe extraction of a string field from unknown tool input (boundary parse). */
export function strField(obj: unknown, key: string): string {
  if (obj !== null && typeof obj === "object") {
    const val = (obj as Record<string, unknown>)[key]
    if (typeof val === "string") return val
  }
  return ""
}

// ---------------------------------------------------------------------------

export function PermissionModal(props: {
  sessionId: string
  deferred?: () => boolean
}): JSX.Element {
  const store = useStore()
  const adapter = useAdapter()
  const toast = useToast()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()

  const permissions = createMemo<PermissionRequest[]>(
    () => store.store.permissions[props.sessionId] ?? [],
  )
  const current = createMemo<PermissionRequest | undefined>(() => permissions()[0])
  const permCount = createMemo(() => permissions().length)
  const narrow = createMemo(() => dims().width < 70)

  const [ui, setUi] = createStore({ selected: 0, fullscreen: false })

  const visible = createMemo(() => permissions().length > 0)

  useOverlay({
    visible,
    deferred: props.deferred,
    onClose: () => {},
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (key.ctrl && name === "f") {
        setUi("fullscreen", (v) => !v)
        return
      }
      if (name === "left") {
        setUi("selected", (v) => (v - 1 + OPTIONS.length) % OPTIONS.length)
        return
      }
      if (name === "right") {
        setUi("selected", (v) => (v + 1) % OPTIONS.length)
        return
      }
      if (name === "return") {
        selectOption(ui.selected)
        return
      }
    },
  })

  // Reset selection when the current permission changes.
  createEffect(() => {
    current()?.id
    setUi("selected", 0)
  })

  async function sendReply(permId: string, reply: PermissionReply): Promise<void> {
    try {
      const response = await adapter.fetch(
        createWrenRequest(`/session/${props.sessionId}/permission/${permId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: reply }),
        }),
      )
      if (!response.ok) {
        let message = `${response.status}`
        try {
          const body = (await response.json()) as { message?: string }
          if (body.message !== undefined) message = `${message}: ${body.message}`
        } catch {
          // Keep the HTTP status when the error response is not JSON.
        }
        toast.show({ title: "Permission reply failed", message, variant: "error" })
      }
    } catch (error) {
      toast.show({
        title: "Permission reply failed",
        message: error instanceof Error ? error.message : "Request failed",
        variant: "error",
      })
    }
  }

  function selectOption(idx: number): void {
    const opt = OPTIONS[idx]
    const perm = current()
    if (opt === undefined || perm === undefined) return
    void sendReply(perm.id, REPLY_MAP[opt.key])
  }

  const content = (): JSX.Element => {
    const t = theme()
    return (
      <box
        borderStyle="double"
        borderColor={t.warning}
        backgroundColor={t.backgroundPanel}
        flexDirection="column"
        {...(ui.fullscreen
          ? {
              position: "absolute" as const,
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 2000,
              maxWidth: dims().width - 2,
            }
          : { flexShrink: 0, maxWidth: Math.min(dims().width - 2, 78) })}
      >
        {/* Header with warning icon + permission counter */}
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingTop={1}
          paddingBottom={1}
          flexShrink={0}
        >
          <text fg={t.warning}>{"\u25b3"}</text>
          <text fg={t.text}>Permission required</text>
          <Show when={permCount() > 1}>
            <text fg={t.textMuted}>{`(${1}/${permCount()})`}</text>
          </Show>
        </box>

        {/* Detail body */}
        <Show when={current()} fallback={<text fg={t.textMuted}> No pending permission</text>}>
          {(perm) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              gap={0}
            >
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={t.tool} flexShrink={0}>
                  {perm().toolName}
                </text>
                <PermissionDetail request={perm()} />
              </box>
            </box>
          )}
        </Show>

        {/* Options bar */}
        <box
          flexDirection="column"
          gap={1}
          border={["top"]}
          borderColor={t.border}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          flexShrink={0}
          backgroundColor={t.backgroundElement}
        >
          <box flexDirection={narrow() ? "column" : "row"} gap={1} flexShrink={0}>
            <For each={OPTIONS}>
              {(opt, idx) => (
                <box
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={idx() === ui.selected ? t.warning : t.backgroundElement}
                  onMouseUp={() => selectOption(idx())}
                >
                  <text fg={idx() === ui.selected ? t.background : t.textMuted} wrapMode="none">
                    {opt.label}
                  </text>
                </box>
              )}
            </For>
          </box>
          <text fg={t.textMuted} flexShrink={0}>
            {`${ui.fullscreen ? "ctrl+f minimize" : "ctrl+f fullscreen"}  \u2190\u2192 select  enter confirm  esc keeps open`}
          </text>
        </box>
      </box>
    )
  }

  return (
    <Show when={permissions().length > 0} fallback={<></>}>
      <box
        position="absolute"
        zIndex={2500}
        left={0}
        right={0}
        bottom={0}
        border={["top"]}
        borderColor={theme().border}
        backgroundColor={theme().backgroundPanel}
      >
        {content()}
      </box>
    </Show>
  )
}

// ---------------------------------------------------------------------------

function PermissionDetail(props: { request: PermissionRequest }): JSX.Element {
  const { theme } = useTheme()
  const req = props.request

  const fallbackStr = (): string =>
    typeof req.input === "string" ? req.input : JSON.stringify(req.input)

  switch (req.displayType) {
    case "edit": {
      const fp = strField(req.input, "filePath") || strField(req.input, "file_path")
      const oldS = strField(req.input, "oldString") || strField(req.input, "old_string")
      const newS = strField(req.input, "newString") || strField(req.input, "new_string")
      return (
        <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingBottom={1}>
          <Show when={fp}>
            <text fg={theme().diffContext} wrapMode="word">
              {fp}
            </text>
          </Show>
          <Show when={oldS}>
            <text fg={theme().diffRemoved} wrapMode="word">{`- ${oldS}`}</text>
          </Show>
          <Show when={newS}>
            <text fg={theme().diffAdded} wrapMode="word">{`+ ${newS}`}</text>
          </Show>
          <Show when={!oldS && !newS}>
            <text fg={theme().textMuted} wrapMode="word">
              {fallbackStr()}
            </text>
          </Show>
        </box>
      )
    }
    case "bash": {
      const cmd = strField(req.input, "command")
      return (
        <Show
          when={cmd}
          fallback={
            <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
              {fallbackStr()}
            </text>
          }
        >
          <box flexDirection="column" paddingLeft={1} paddingBottom={1}>
            <text fg={theme().syntaxString} wrapMode="word">{`$ ${cmd}`}</text>
          </box>
        </Show>
      )
    }
    case "read":
    case "write": {
      const fp = strField(req.input, "filePath") || strField(req.input, "path")
      return (
        <Show
          when={fp}
          fallback={
            <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
              {fallbackStr()}
            </text>
          }
        >
          <text fg={theme().diffContext} wrapMode="word" paddingLeft={1}>
            {fp}
          </text>
        </Show>
      )
    }
    case "glob":
    case "grep": {
      const pattern = strField(req.input, "pattern")
      return (
        <Show
          when={pattern}
          fallback={
            <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
              {fallbackStr()}
            </text>
          }
        >
          <text fg={theme().syntaxKeyword} wrapMode="word" paddingLeft={1}>
            {pattern}
          </text>
        </Show>
      )
    }
    case "webfetch": {
      const url = strField(req.input, "url")
      return (
        <Show
          when={url}
          fallback={
            <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
              {fallbackStr()}
            </text>
          }
        >
          <text fg={theme().markdownLink} wrapMode="word" paddingLeft={1}>
            {url}
          </text>
        </Show>
      )
    }
    case "websearch": {
      const query = strField(req.input, "query")
      return (
        <Show
          when={query}
          fallback={
            <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
              {fallbackStr()}
            </text>
          }
        >
          <text fg={theme().markdownLink} wrapMode="word" paddingLeft={1}>
            {query}
          </text>
        </Show>
      )
    }
    case "task": {
      const desc = strField(req.input, "description")
      return (
        <Show
          when={desc}
          fallback={
            <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
              {fallbackStr()}
            </text>
          }
        >
          <text fg={theme().text} wrapMode="word" paddingLeft={1}>
            {desc}
          </text>
        </Show>
      )
    }
    default:
      return (
        <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
          {fallbackStr()}
        </text>
      )
  }
}

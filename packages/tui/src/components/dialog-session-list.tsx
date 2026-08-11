/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import type { Session } from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useDialog } from "../context/dialog"
import { useRoute } from "../context/route"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { useToast } from "../ui/toast"
import { fuzzyMatch } from "./fuzzy"

export function DialogSessionList(props: {
  visible: () => boolean
  onClose: () => void
}): JSX.Element {
  const store = useStore()
  const adapter = useAdapter()
  const dialog = useDialog()
  const { theme } = useTheme()
  const { route, navigate } = useRoute()
  const toast = useToast()
  const dims = useTerminalDimensions()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)

  const sessions = createMemo<Session[]>(() => store.store.sessions)

  const sessionPreviews = createMemo(() => {
    const titles = adapter.titles?.()
    return sessions().map((session) => {
      const preview = store.store.previews[session.id]
      const title = titles?.[session.id]
      return {
        session,
        preview: title ?? preview?.text ?? "",
        timestamp: preview?.createdAt ?? "",
      }
    })
  })

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    return sessionPreviews()
      .filter(
        (item) =>
          needle === "" ||
          fuzzyMatch(needle, item.preview),
      )
      .sort((a, b) => {
        const ta = new Date(a.timestamp).getTime()
        const tb = new Date(b.timestamp).getTime()
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
        if (Number.isNaN(ta)) return 1
        if (Number.isNaN(tb)) return -1
        return tb - ta
      })
  })

  const grouped = createMemo(() => {
    const items = filtered()
    const groups: { label: string; items: typeof items }[] = []
    let currentLabel = ""
    for (const item of items) {
      const label = dateGroupLabel(item.timestamp)
      if (label !== currentLabel) {
        currentLabel = label
        groups.push({ label, items: [item] })
      } else {
        groups[groups.length - 1]?.items.push(item)
      }
    }
    return groups
  })

  const flatItems = createMemo(() => {
    const result: { session: Session; preview: string; timestamp: string; groupLabel: string }[] =
      []
    for (const group of grouped()) {
      for (const item of group.items) {
        result.push({ ...item, groupLabel: group.label })
      }
    }
    return result
  })

  createEffect(() => {
    const lastIndex = Math.max(0, flatItems().length - 1)
    setSelected((current) => Math.min(current, lastIndex))
  })

  async function deleteSession(sessionId: string): Promise<void> {
    try {
      const res = await adapter.fetch(
        createWrenRequest(`/session/${sessionId}`, { method: "DELETE" }),
      )
      if (res.ok) {
        toast.show({ title: "Session deleted", message: sessionId, variant: "info" })
        const r = route()
        if (r.type === "session" && r.sessionId === sessionId) {
          navigate({ type: "home" })
        }
      } else {
        toast.show({
          title: "Delete failed",
          message: `${sessionId} (${res.status})`,
          variant: "error",
        })
      }
    } catch {
      toast.show({ title: "Delete failed", message: sessionId, variant: "error" })
    }
  }

  async function renameSession(sessionId: string, currentName: string): Promise<void> {
    const result = await dialog.prompt("Rename session", {
      description: "Enter a new name for this session",
      value: currentName,
    })
    if (result === undefined || result.trim() === "") return
    try {
      const res = await adapter.fetch(
        createWrenRequest(`/session/${sessionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: result.trim() }),
        }),
      )
      if (res.ok) {
        toast.show({ title: "Session renamed", message: result.trim(), variant: "success" })
      } else {
        toast.show({ title: "Rename failed", message: `(${res.status})`, variant: "error" })
      }
    } catch {
      toast.show({ title: "Rename failed", message: sessionId, variant: "error" })
    }
  }

  useOverlay({
    visible: props.visible,
    onClose: () => {
      if (confirmDelete() !== null) {
        setConfirmDelete(null)
        return
      }
      setFilter("")
      setSelected(0)
      props.onClose()
    },
    deferred: () => dialog.stack().length > 0,
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "up" || (key.ctrl && name === "p")) {
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      if (name === "down" || (key.ctrl && name === "n")) {
        setSelected((s) => Math.min(Math.max(0, flatItems().length - 1), s + 1))
        return
      }
      if (name === "return") {
        const item = flatItems()[selected()]
        if (item) {
          navigate({ type: "session", sessionId: item.session.id })
          props.onClose()
        }
        return
      }
      if (name === "r") {
        const item = flatItems()[selected()]
        if (item) {
          void renameSession(item.session.id, item.preview)
        }
        return
      }
      if (name === "d") {
        const item = flatItems()[selected()]
        if (item) {
          if (confirmDelete() === item.session.id) {
            void deleteSession(item.session.id)
            setConfirmDelete(null)
          } else {
            setConfirmDelete(item.session.id)
          }
        }
        return
      }
      if (name === "backspace") {
        setFilter((f) => f.slice(0, -1))
        setSelected(0)
        return
      }
      if (name === "space" && !key.ctrl && !key.meta) {
        setFilter((f) => `${f} `)
        setSelected(0)
        return
      }
      if (name.length === 1 && !key.ctrl && !key.meta) {
        const char = key.shift ? name.toUpperCase() : name
        setFilter((f) => f + char)
        setSelected(0)
        return
      }
    },
  })

  const dialogWidth = createMemo(() => Math.min(70, dims().width - 4))

  return (
    <Show when={props.visible()}>
      <box
        flexGrow={1}
        alignItems="center"
        paddingTop={Math.floor(dims().height / 6)}
        backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      >
        <box
          width={dialogWidth()}
          backgroundColor={theme().backgroundPanel}
          border
          borderColor={theme().border}
          paddingTop={1}
          paddingBottom={1}
        >
          <box paddingLeft={2} paddingRight={2}>
            <text attributes={TextAttributes.BOLD} fg={theme().text}>
              Sessions
            </text>
          </box>
          <Show when={filter() !== ""}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>Filter: {filter()}</text>
            </box>
          </Show>
          <Show
            when={flatItems().length > 0}
            fallback={
              <box paddingLeft={2}>
                <text fg={theme().textMuted}>No sessions found</text>
              </box>
            }
          >
            <scrollbox
              flexGrow={1}
              maxHeight={Math.floor(dims().height / 3)}
              verticalScrollbarOptions={{ visible: false }}
            >
              <For each={flatItems()}>
                {(item, idx) => {
                  const isSel = () => idx() === selected()
                  const isConfirmDelete = () => confirmDelete() === item.session.id
                  const showGroup = () =>
                    idx() === 0 || flatItems()[idx() - 1]?.groupLabel !== item.groupLabel
                  return (
                    <box flexDirection="column">
                      <Show when={showGroup()}>
                        <box paddingLeft={1} paddingTop={1}>
                          <text fg={theme().textMuted} attributes={TextAttributes.BOLD}>
                            {item.groupLabel}
                          </text>
                        </box>
                      </Show>
                      <box
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        backgroundColor={isSel() ? theme().selectionBg : undefined}
                      >
                        <text fg={isSel() ? theme().accent : theme().textMuted}>
                          {isSel() ? "\u25b8" : " "}
                        </text>
                        <text
                          fg={isSel() ? theme().text : theme().textMuted}
                          attributes={isSel() ? TextAttributes.BOLD : undefined}
                          width={11}
                          flexShrink={0}
                        >
                          {formatTime(item.timestamp)}
                        </text>
                        <box flexGrow={1} minWidth={0}>
                          <text
                            fg={
                              isConfirmDelete()
                                ? theme().error
                                : isSel()
                                  ? theme().text
                                  : theme().textMuted
                            }
                            wrapMode="none"
                          >
                            {isConfirmDelete()
                              ? `Press d again to delete: ${item.preview}`
                              : item.preview}
                          </text>
                        </box>
                      </box>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
          <box paddingLeft={2} marginTop={1}>
            <text
              fg={theme().textMuted}
              wrapMode="none"
              children={"enter resume \u00b7 r rename \u00b7 d delete \u00b7 esc cancel"}
            />
          </box>
        </box>
      </box>
    </Show>
  )
}

function dateGroupLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Unknown"
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (sessionDate.getTime() === today.getTime()) return "Today"
  if (sessionDate.getTime() === yesterday.getTime()) return "Yesterday"
  const diffDays = Math.floor((today.getTime() - sessionDate.getTime()) / 86400000)
  if (diffDays < 7) return "This Week"
  if (diffDays < 30) return "This Month"
  return "Older"
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "  --  "
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const min = String(date.getMinutes()).padStart(2, "0")
  return `${m}/${d} ${h}:${min}`
}

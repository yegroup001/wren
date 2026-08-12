/** @jsxImportSource @opentui/solid */

import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useAdapter } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { fuzzyMatch } from "./fuzzy"

type AgentInfo = { name: string; description: string }

export function DialogAgent(props: { visible: () => boolean; onClose: () => void }): JSX.Element {
  const adapter = useAdapter()
  const local = useLocal()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const [allAgents, setAllAgents] = createSignal<AgentInfo[]>([])
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(false)

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    if (needle === "") return allAgents()
    return allAgents().filter(
      (a) => fuzzyMatch(needle, a.name) || fuzzyMatch(needle, a.description),
    )
  })

  useOverlay({
    visible: props.visible,
    onClose: () => {
      setFilter("")
      setSelected(0)
      props.onClose()
    },
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "up") {
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      if (name === "down") {
        setSelected((s) => Math.min(Math.max(0, filtered().length - 1), s + 1))
        return
      }
      if (name === "return") {
        const agent = filtered()[selected()]
        if (agent) {
          local.setAgent(agent.name)
          props.onClose()
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

  createEffect(() => {
    if (!props.visible()) return
    setLoading(true)
    setFilter("")
    setSelected(0)
    void (async () => {
      try {
        const res = await adapter.fetch(createWrenRequest("/config"))
        if (res.ok) {
          const config = (await res.json()) as { agents?: string[] }
          const list = (config.agents ?? []).map((name) => ({ name, description: "" }))
          setAllAgents(list)
        }
      } catch {
        setAllAgents([])
      } finally {
        setLoading(false)
      }
    })()
  })

  const dialogWidth = createMemo(() => Math.min(56, dims().width - 4))

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
              Select Agent
            </text>
          </box>
          <Show when={filter() !== ""}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>
                Filter: {filter()}
                {`\u2588`}
              </text>
            </box>
          </Show>
          <Show when={loading()}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>Loading...</text>
            </box>
          </Show>
          <Show when={!loading() && filtered().length === 0}>
            <box paddingLeft={2}>
              <text fg={theme().textMuted}>No agents available</text>
            </box>
          </Show>
          <Show when={filtered().length > 0}>
            <scrollbox
              flexGrow={1}
              maxHeight={Math.floor(dims().height / 3)}
              verticalScrollbarOptions={{ visible: false }}
            >
              <For each={filtered()}>
                {(agent, idx) => {
                  const isSel = () => idx() === selected()
                  return (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={2}
                      backgroundColor={isSel() ? theme().selectionBg : undefined}
                    >
                      <text fg={isSel() ? theme().accent : theme().textMuted}>
                        {isSel() ? `\u25b8` : " "}
                      </text>
                      <text
                        fg={isSel() ? theme().text : theme().textMuted}
                        attributes={isSel() ? TextAttributes.BOLD : undefined}
                      >
                        {agent.name}
                      </text>
                      <Show when={agent.name === local.agent()}>
                        <text fg={theme().success}>{"(current)"}</text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
          <box paddingLeft={2} marginTop={1}>
            <text fg={theme().textMuted} wrapMode="none">
              {"type filter · enter select · esc"}
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}

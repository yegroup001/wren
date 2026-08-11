/** @jsxImportSource @opentui/solid */

import { type KeyEvent, TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createWrenRequest } from "@wren/adapter"
import type { QuestionRequest } from "@wren/protocol"
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useAdapter, useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { promptTextareaKeyBindings } from "./prompt-keybindings"

export function QuestionModal(props: { sessionId: string; deferred?: () => boolean }): JSX.Element {
  const store = useStore()
  const adapter = useAdapter()
  const { theme } = useTheme()
  const dims = useTerminalDimensions()

  const questions = createMemo<QuestionRequest[]>(
    () => store.store.questions[props.sessionId] ?? [],
  )
  const hasPendingPermission = createMemo(
    () => (store.store.permissions[props.sessionId]?.length ?? 0) > 0,
  )
  const current = createMemo<QuestionRequest | undefined>(() => questions()[0])
  const activeQuestion = createMemo<QuestionRequest | undefined>(() =>
    hasPendingPermission() ? undefined : current(),
  )

  const [selected, setSelected] = createSignal(0)
  const [selectedOptions, setSelectedOptions] = createSignal<readonly string[]>([])
  const [customText, setCustomText] = createSignal("")
  const [editing, setEditing] = createSignal(false)

  useOverlay({
    visible: () => activeQuestion() !== undefined,
    deferred: () => editing() || (props.deferred?.() ?? false),
    onClose: () => {
      const req = activeQuestion()
      if (req === undefined) return
      sendReject(req)
    },
    onKey: (key: KeyEvent) => {
      const req = activeQuestion()
      if (req === undefined) return
      const name = key.name

      if (name === "up" || name === "k") {
        setSelected((s) => Math.max(0, s - 1))
        return
      }
      if (name === "down" || name === "j") {
        setSelected((s) => Math.min(req.options.length, s + 1))
        return
      }
      if (req.multiSelect && name === "space" && selected() < req.options.length) {
        const option = req.options[selected()]
        if (option !== undefined) {
          setSelectedOptions((options) =>
            options.includes(option.label)
              ? options.filter((label) => label !== option.label)
              : [...options, option.label],
          )
        }
        return
      }
      if (name === "return") {
        const opts = req.options
        if (req.multiSelect && selected() < opts.length) {
          const answers = selectedOptions()
          if (answers.length > 0) sendReply(req, answers)
          return
        }
        if (selected() < opts.length) {
          const selectedOption = opts[selected()]
          if (selectedOption === undefined) return
          sendReply(req, [selectedOption.label])
          return
        }
        setEditing(true)
        setCustomText("")
        return
      }
    },
  })

  // Reset state when the current question changes.
  createEffect(() => {
    activeQuestion()?.id
    setSelected(0)
    setEditing(false)
    setCustomText("")
    setSelectedOptions([])
  })

  function sendReply(request: QuestionRequest, answers: readonly string[]): void {
    void adapter.fetch(
      createWrenRequest(`/session/${props.sessionId}/question/${request.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      }),
    )
  }

  function sendReject(request: QuestionRequest): void {
    void adapter.fetch(
      createWrenRequest(`/session/${props.sessionId}/question/${request.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [], rejected: true }),
      }),
    )
  }

  function submitCustomAnswer(): void {
    if (!editing()) return
    const req = activeQuestion()
    if (req === undefined) return
    const text = customText().trim()
    const answers = [...selectedOptions(), text].filter((answer) => answer.length > 0)
    if (answers.length > 0) {
      sendReply(req, answers)
    }
    setEditing(false)
  }

  const dialogWidth = createMemo(() => Math.min(70, dims().width - 4))

  return (
    <Show when={activeQuestion()}>
      {(req) => (
        <box
          position="absolute"
          zIndex={2800}
          left={0}
          right={0}
          top={0}
          paddingTop={Math.floor(dims().height / 4)}
          alignItems="center"
        >
          <box
            width={dialogWidth()}
            flexShrink={0}
            backgroundColor={theme().backgroundPanel}
            borderStyle="double"
            borderColor={theme().warning}
            paddingTop={1}
            paddingBottom={1}
          >
            <QuestionModalContent
              req={req}
              selected={selected}
              editing={editing}
              selectedOptions={selectedOptions}
              theme={theme}
              onContentChange={setCustomText}
              onSubmit={submitCustomAnswer}
              onCancel={() => setEditing(false)}
            />
          </box>
        </box>
      )}
    </Show>
  )
}

function QuestionModalContent(props: {
  req: () => QuestionRequest
  selected: () => number
  editing: () => boolean
  selectedOptions: () => readonly string[]
  theme: () => import("../theme/themes").TuiTheme
  onContentChange: (text: string) => void
  onSubmit: () => void
  onCancel: () => void
}): JSX.Element {
  const t = props.theme
  let textareaRef: TextareaRenderable | undefined
  return (
    <>
      <box paddingLeft={2} paddingRight={2}>
        <text attributes={TextAttributes.BOLD} fg={t().text}>
          {props.req().title}
        </text>
      </box>
      <Show when={props.req().detail.length > 0}>
        <box paddingLeft={2} paddingRight={2}>
          <text fg={t().textMuted} wrapMode="word">
            {props.req().detail}
          </text>
        </box>
      </Show>
      <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1} marginTop={1}>
        <For each={props.req().options}>
          {(opt, idx) => {
            const isSel = () => idx() === props.selected()
            const isChecked = () =>
              props.req().multiSelect && props.selectedOptions().includes(opt.label)
            return (
              <box flexDirection="row" gap={1} paddingLeft={1}>
                <text fg={isSel() ? t().accent : t().textMuted}>{isSel() ? "\u25b8" : " "}</text>
                <text
                  fg={isSel() ? t().text : t().textMuted}
                  children={
                    props.req().multiSelect
                      ? `${isChecked() ? "[✓]" : "[ ]"} ${opt.label}`
                      : opt.label
                  }
                />
              </box>
            )
          }}
        </For>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={props.selected() === props.req().options.length ? t().accent : t().textMuted}>
            {props.selected() === props.req().options.length ? "\u25b8" : " "}
          </text>
          <text fg={props.selected() === props.req().options.length ? t().text : t().textMuted}>
            Type your own answer
          </text>
        </box>
      </box>
      <Show when={props.editing()}>
        <box paddingLeft={2} marginTop={1}>
          <textarea
            ref={(r: TextareaRenderable) => {
              textareaRef = r
            }}
            placeholder="Type your answer..."
            onContentChange={() => {
              if (textareaRef) {
                props.onContentChange(textareaRef.plainText)
              }
            }}
            onSubmit={() => props.onSubmit()}
            onKeyDown={(key: KeyEvent) => {
              if (key.name !== "escape") return
              key.preventDefault()
              key.stopPropagation()
              props.onCancel()
            }}
            keyBindings={promptTextareaKeyBindings}
            focused={true}
            flexGrow={1}
            minHeight={3}
            backgroundColor={t().backgroundElement}
            textColor={t().text}
            placeholderColor={t().textMuted}
          />
        </box>
      </Show>
      <box paddingLeft={2} marginTop={1}>
        <text fg={t().textMuted}>
          {props.req().multiSelect
            ? "space toggle · enter confirm · esc dismiss"
            : "enter select · esc dismiss · ←→ home end"}
        </text>
      </box>
    </>
  )
}

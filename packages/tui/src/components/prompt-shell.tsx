import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { Status } from "@wren/protocol"
import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "../ui/spinner"
import { VERSION } from "../version"

type PromptShellProps = {
  readonly cwd?: string
  readonly model: string
  readonly variant: string
  readonly permissionMode: string
  readonly pasteSummary: string | undefined
  readonly status: Status
  readonly interruptCount: number
  readonly tokenText?: string
  readonly contextPercent?: string
  readonly contextColor?: string
  readonly hasContent?: boolean
  readonly showHints?: boolean
  readonly editReplacement?: boolean
  readonly children: JSX.Element
}

export function PromptShell(props: PromptShellProps): JSX.Element {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const narrow = createMemo(() => dims().width < 80)

  const busy = (): boolean => props.status.type !== "idle"
  const stateColor = (): string => {
    if (props.status.type === "idle") return theme().success
    if (props.status.type === "retry") return theme().warning
    if (props.status.type === "compacting") return theme().accent
    return theme().info
  }
  const statusTextColor = (): string => {
    if (props.status.type === "compacting") return theme().accent
    if (props.status.type === "retry") return theme().warning
    return busy() ? theme().info : theme().textMuted
  }
  const statusText = (): string => {
    if (props.status.type === "working") return "working"
    if (props.status.type === "compacting") return "compacting"
    if (props.status.type === "retry")
      return `retry ${props.status.attempt}/${props.status.maxRetries}`
    return "ready"
  }

  const [dotVisible, setDotVisible] = createSignal(true)
  let blinkTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    blinkTimer = setInterval(() => {
      if (busy()) setDotVisible((prev) => !prev)
      else if (!dotVisible()) setDotVisible(true)
    }, 500)
  })
  onCleanup(() => {
    if (blinkTimer !== undefined) clearInterval(blinkTimer)
  })

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle={busy() ? "double" : "single"}
      borderColor={busy() ? theme().borderActive : theme().border}
      backgroundColor={theme().backgroundPanel}
      overflow="hidden"
    >
      <box
        flexDirection={narrow() ? "column" : "row"}
        justifyContent="space-between"
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme().backgroundElement}
        overflow="hidden"
        minWidth={0}
      >
        <box flexDirection="row" gap={1} minWidth={0} flexGrow={1} overflow="hidden">
          <text fg={theme().primary} attributes={TextAttributes.BOLD} flexShrink={0}>
            Wren
          </text>
          <text fg={theme().textMuted} flexShrink={0}>{`v${VERSION}`}</text>
          <Show when={props.cwd}>
            <text fg={theme().textMuted} flexShrink={0}>
              {"│"}
            </text>
            <text fg={theme().textMuted} flexShrink={0}>{`\u25ce ${props.cwd}`}</text>
          </Show>
          <text fg={theme().textMuted} flexShrink={0}>
            {"│"}
          </text>
          <text fg={theme().textMuted} flexShrink={0}>
            {"model:"}
          </text>
          <text fg={theme().accent} wrapMode="none" flexShrink={1}>
            {props.model}
          </text>
          <text fg={theme().primary} flexShrink={0}>
            {props.variant}
          </text>
          <Show when={props.permissionMode !== "default"}>
            <text fg={theme().textMuted} flexShrink={0}>
              {"│"}
            </text>
            <text
              fg={
                props.permissionMode === "plan"
                  ? theme().warning
                  : props.permissionMode === "auto"
                    ? theme().accent
                    : props.permissionMode === "acceptEdits"
                      ? theme().success
                      : props.permissionMode === "full"
                        ? theme().error
                        : theme().textMuted
              }
              flexShrink={0}
            >
              {props.permissionMode === "plan"
                ? "PLAN MODE"
                : props.permissionMode === "auto"
                  ? "AUTO MODE"
                  : props.permissionMode === "acceptEdits"
                    ? "ACCEPT EDITS"
                    : props.permissionMode === "full"
                      ? "FULL MODE"
                      : ""}
            </text>
          </Show>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Show when={props.tokenText}>
            <text fg={theme().textMuted}>{props.tokenText}</text>
          </Show>
          <Show when={props.contextPercent}>
            <text fg={props.contextColor ?? theme().textMuted}>{props.contextPercent}</text>
          </Show>
          <text fg={stateColor()}>{busy() && !dotVisible() ? " " : "●"}</text>
          <text fg={statusTextColor()}>{statusText()}</text>
        </box>
      </box>

      <box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme().backgroundPanel}
      >
        <box
          border={["left"]}
          borderColor={theme().accent}
          paddingLeft={1}
          backgroundColor={theme().backgroundPanel}
        >
          <box>{props.children}</box>
        </box>
      </box>

      <Show when={props.showHints ?? true}>
        <box
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme().backgroundElement}
        >
          <box flexDirection="row" gap={1}>
            <text
              fg={
                props.editReplacement
                  ? theme().warning
                  : props.hasContent
                    ? theme().border
                    : theme().accent
              }
            >
              {props.editReplacement ? "enter replace branch" : "Enter send"}
            </text>
            <text fg={props.hasContent ? theme().border : theme().textMuted}>Shift+Enter line</text>
          </box>
          <box flexDirection="row" gap={1}>
            <Show when={!narrow() ? props.pasteSummary : undefined}>
              {(summary) => <text fg={theme().textMuted}>{summary()}</text>}
            </Show>
            <Show when={busy()}>
              <Spinner style="dots" color={theme().info} />
              <text fg={props.interruptCount > 0 ? theme().primary : theme().textMuted}>
                esc {props.interruptCount > 0 ? "again to interrupt" : "interrupt"}
              </text>
            </Show>
          </box>
        </box>
      </Show>
    </box>
  )
}

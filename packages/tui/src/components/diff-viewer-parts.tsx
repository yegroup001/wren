/** @jsxImportSource @opentui/solid */

import type { DiffRenderable, SyntaxStyle } from "@opentui/core"
import type { SnapshotFileDiff } from "@wren/protocol"
import { type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import type { TuiTheme } from "../theme/themes"

export type DiffView = "split" | "unified"
export type DiffFocus = "patches" | "files"

export function DiffViewerHeader(props: {
  fileCount: number
  view: DiffView
  focus: DiffFocus
  splitAvailable: boolean
  theme: () => TuiTheme
}): JSX.Element {
  const t = () => props.theme()
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text fg={t().text}>Diff </text>
      <text fg={t().textMuted}>
        {`${props.fileCount} ${props.fileCount === 1 ? "file" : "files"}`}
      </text>
      <box flexGrow={1} />
      <Show when={props.splitAvailable}>
        <text fg={t().textMuted}>{` ${props.view} `}</text>
      </Show>
      <text fg={t().textMuted}>{` ${props.focus}`}</text>
    </box>
  )
}

export function DiffViewerFooter(props: {
  theme: () => TuiTheme
  splitAvailable: boolean
}): JSX.Element {
  const t = () => props.theme()
  return (
    <box flexDirection="row" paddingLeft={1} gap={2} flexShrink={0}>
      <text fg={t().text}>
        {"j/k"} <span style={{ fg: t().textMuted }}>scroll</span>
      </text>
      <text fg={t().text}>
        {"[/]"} <span style={{ fg: t().textMuted }}>next/prev file</span>
      </text>
      <Show when={props.splitAvailable}>
        <text fg={t().text}>
          {"s"} <span style={{ fg: t().textMuted }}>toggle view</span>
        </text>
      </Show>
      <text fg={t().text}>
        {"tab"} <span style={{ fg: t().textMuted }}>focus</span>
      </text>
      <text fg={t().text}>
        {"q/esc"} <span style={{ fg: t().textMuted }}>close</span>
      </text>
    </box>
  )
}

export function DiffFileEntry(props: {
  file: SnapshotFileDiff
  showSeparator: boolean
  view: DiffView
  syntax: SyntaxStyle
}): JSX.Element {
  const { theme } = useTheme()
  const t = () => theme()
  const patch = (): string => generatePatch(props.file)

  return (
    <box flexDirection="column">
      <Show when={props.showSeparator}>
        <box height={1} />
      </Show>
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={t().text} wrapMode="none">
          {props.file.path}
        </text>
        <box flexGrow={1} />
        <text fg={t().diffAdded}>{`+${props.file.added}`}</text>
        <text fg={t().diffRemoved}>{`-${props.file.removed}`}</text>
      </box>
      <Show
        when={patch().length > 0}
        fallback={<text fg={t().textMuted}> No patch available</text>}
      >
        <box paddingLeft={1} paddingRight={1}>
          <diff
            ref={(_el: DiffRenderable) => {}}
            diff={patch()}
            view={props.view}
            showLineNumbers={true}
            width="100%"
            wrapMode="none"
            fg={t().text}
            addedBg={t().backgroundElement}
            removedBg={t().background}
            addedSignColor={t().diffAdded}
            removedSignColor={t().diffRemoved}
            lineNumberFg={t().textMuted}
            syntaxStyle={props.syntax}
          />
        </box>
      </Show>
    </box>
  )
}

export function generatePatch(file: SnapshotFileDiff): string {
  const patchStr = (file as Record<string, unknown>).patch
  if (typeof patchStr === "string" && patchStr.length > 0) return patchStr
  return ""
}

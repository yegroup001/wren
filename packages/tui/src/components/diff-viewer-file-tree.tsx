/** @jsxImportSource @opentui/solid */

import type { SnapshotFileDiff } from "@wren/protocol"
import { createMemo, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { buildFileTree, type DiffFileTreeRow, flattenFileTree } from "./diff-viewer-utils"

export type DiffViewerFileTreeProps = {
  readonly files: readonly SnapshotFileDiff[]
  readonly width: number
  readonly expandedNodes: ReadonlySet<number>
  readonly highlightedNode: number | undefined
  readonly selectedFileIndex: number | undefined
  readonly focused: boolean
  readonly onRowClick: (row: DiffFileTreeRow) => void
}

export function DiffViewerFileTree(props: DiffViewerFileTreeProps): JSX.Element {
  const { theme } = useTheme()

  const tree = createMemo(() => buildFileTree(props.files))
  const rows = createMemo(() => flattenFileTree(tree(), props.expandedNodes))

  return (
    <box
      border
      borderColor={theme().border}
      width={props.width}
      flexDirection="column"
      flexShrink={0}
    >
      <box paddingLeft={1} flexShrink={0}>
        <text fg={theme().textMuted}>Files</text>
      </box>
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <Show when={rows().length > 0} fallback={<text fg={theme().textMuted}>No files</text>}>
          <For each={rows()}>
            {(row, index) => {
              const highlighted = () => props.focused && props.highlightedNode === row.id
              const selected = () =>
                row.fileIndex !== undefined && props.selectedFileIndex === row.fileIndex
              return (
                <FileTreeRow
                  row={row}
                  rows={rows()}
                  index={index()}
                  isHighlighted={highlighted()}
                  isSelected={selected()}
                  isExpanded={props.expandedNodes.has(row.id)}
                  onRowClick={props.onRowClick}
                />
              )
            }}
          </For>
        </Show>
      </scrollbox>
    </box>
  )
}

function FileTreeRow(props: {
  row: DiffFileTreeRow
  rows: readonly DiffFileTreeRow[]
  index: number
  isHighlighted: boolean
  isSelected: boolean
  isExpanded: boolean
  onRowClick: (row: DiffFileTreeRow) => void
}): JSX.Element {
  const { theme } = useTheme()
  const t = () => theme()

  const prefix = (): string =>
    fileTreeRowPrefix(props.rows, props.index, props.row, props.isExpanded)
  const statusChar = (): string => props.row.status ?? ""

  return (
    <box
      flexDirection="row"
      width="100%"
      backgroundColor={props.isHighlighted ? t().accent : undefined}
      onMouseUp={() => props.onRowClick(props.row)}
    >
      <text
        fg={props.isHighlighted ? t().background : t().textMuted}
        wrapMode="none"
        flexShrink={0}
      >
        {prefix()}
      </text>
      <box flexGrow={1} minWidth={0}>
        <text
          fg={
            props.isHighlighted
              ? t().background
              : props.isSelected
                ? t().accent
                : props.row.kind === "directory"
                  ? t().textMuted
                  : t().text
          }
          wrapMode="none"
        >
          {props.row.name}
        </text>
      </box>
      <text
        fg={props.isHighlighted ? t().background : t().textMuted}
        wrapMode="none"
        flexShrink={0}
      >
        {` ${statusChar()}`}
      </text>
    </box>
  )
}

function fileTreeRowPrefix(
  rows: readonly DiffFileTreeRow[],
  index: number,
  row: DiffFileTreeRow,
  expanded: boolean,
): string {
  const indentation = Array.from({ length: row.depth }, (_, depth) => {
    if (depth === 0 && !hasLaterSibling(rows, index, 0)) return " "
    return hasLaterSibling(rows, index, depth) ? "\u2502  " : "   "
  }).join("")
  const topRoot = index === 0 && row.depth === 0
  const branch = topRoot
    ? " "
    : hasLaterSibling(rows, index, row.depth)
      ? "\u251c\u2500 "
      : "\u2514\u2500 "
  const marker = row.kind === "directory" ? (expanded ? "\u25be " : "\u25b8 ") : ""
  return `${indentation}${branch}${marker}`
}

function hasLaterSibling(rows: readonly DiffFileTreeRow[], index: number, depth: number): boolean {
  return rows.slice(index + 1).find((row) => row.depth <= depth)?.depth === depth
}

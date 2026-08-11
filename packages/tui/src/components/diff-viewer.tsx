/** @jsxImportSource @opentui/solid */

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import type { SnapshotFileDiff } from "@wren/protocol"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js"
import { useStore } from "../context/store"
import { useTheme } from "../context/theme"
import { useOverlay } from "../hooks/use-overlay"
import { DiffViewerFileTree } from "./diff-viewer-file-tree"
import {
  DiffFileEntry,
  type DiffFocus,
  type DiffView,
  DiffViewerFooter,
  DiffViewerHeader,
} from "./diff-viewer-parts"
import {
  allExpandedDirectories,
  buildFileTree,
  type DiffFileTreeRow,
  flattenFileTree,
  moveSelection,
  nextFileIndex,
  prevFileIndex,
  toggleDirectory,
} from "./diff-viewer-utils"
import { useSyntaxStyle } from "./syntax"

const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 30

export function DiffViewer(props: {
  sessionId: string
  visible: () => boolean
  onClose: () => void
}): JSX.Element {
  const store = useStore()
  const { theme } = useTheme()
  const syntax = useSyntaxStyle()
  const dims = useTerminalDimensions()

  const files = createMemo<SnapshotFileDiff[]>(
    () => store.store.diffs[props.sessionId]?.files ?? [],
  )
  const tree = createMemo(() => buildFileTree(files()))

  const [view, setView] = createSignal<DiffView>("unified")
  const [focus, setFocus] = createSignal<DiffFocus>("patches")
  const [expandedNodes, setExpandedNodes] = createSignal<ReadonlySet<number>>(
    allExpandedDirectories(tree()),
  )
  const [highlightedNode, setHighlightedNode] = createSignal<number | undefined>(undefined)
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | undefined>(undefined)

  const rows = createMemo(() => flattenFileTree(tree(), expandedNodes()))
  const splitAvailable = createMemo(() => dims().width >= MIN_SPLIT_WIDTH)
  const effectiveView = createMemo<DiffView>(() => (splitAvailable() ? view() : "unified"))
  const showFileTree = createMemo(() => files().length > 1)

  createEffect(() => {
    if (files().length > 0 && selectedFileIndex() === undefined) {
      setExpandedNodes(allExpandedDirectories(tree()))
      setHighlightedNode(rows().find((r) => r.fileIndex !== undefined)?.id)
      setSelectedFileIndex(0)
    }
  })

  let scrollRef: ScrollBoxRenderable | undefined

  useOverlay({
    visible: props.visible,
    onClose: () => props.onClose(),
    onKey: (key: KeyEvent) => {
      const name = key.name
      if (name === "q") {
        props.onClose()
        return
      }
      if (focus() === "files") return handleFileTreeKey(name)
      handlePatchesKey(name, key.ctrl)
    },
  })

  function handleFileTreeKey(name: string): void {
    if (name === "j" || name === "down") {
      setHighlightedNode(moveSelection(rows(), highlightedNode(), 1))
      return
    }
    if (name === "k" || name === "up") {
      setHighlightedNode(moveSelection(rows(), highlightedNode(), -1))
      return
    }
    if (name === "return" || name === "l" || name === "right") {
      const row = rows().find((r) => r.id === highlightedNode())
      if (row) handleRowClick(row)
      return
    }
    if (name === "h" || name === "left") {
      setExpandedNodes(toggleDirectory(tree(), expandedNodes(), highlightedNode()))
      return
    }
    if (name === "tab") {
      setFocus("patches")
      return
    }
  }

  function handlePatchesKey(name: string, ctrl: boolean): void {
    if (name === "j" || name === "down") {
      scrollRef?.scrollBy(1)
      return
    }
    if (name === "k" || name === "up") {
      scrollRef?.scrollBy(-1)
      return
    }
    if (name === "]") {
      const next = nextFileIndex(rows(), selectedFileIndex())
      if (next !== undefined) {
        setSelectedFileIndex(next)
        scrollRef?.scrollTo(0)
      }
      return
    }
    if (name === "[") {
      const prev = prevFileIndex(rows(), selectedFileIndex())
      if (prev !== undefined) {
        setSelectedFileIndex(prev)
        scrollRef?.scrollTo(0)
      }
      return
    }
    if (name === "tab") {
      setFocus("files")
      return
    }
    if (name === "s" && splitAvailable()) {
      setView((v) => (v === "split" ? "unified" : "split"))
      return
    }
    if (ctrl && name === "d") {
      props.onClose()
      return
    }
  }

  function handleRowClick(row: DiffFileTreeRow): void {
    setHighlightedNode(row.id)
    if (row.fileIndex !== undefined) {
      setSelectedFileIndex(row.fileIndex)
      setFocus("patches")
      return
    }
    setExpandedNodes(toggleDirectory(tree(), expandedNodes(), row.id))
  }

  const visibleFiles = createMemo<SnapshotFileDiff[]>(() => {
    const idx = selectedFileIndex()
    if (idx === undefined) return files()
    const file = files()[idx]
    return file ? [file] : files()
  })

  return (
    <Show when={props.visible()}>
      <Portal>
        <box
          position="absolute"
          zIndex={2500}
          left={0}
          top={0}
          width={dims().width}
          height={dims().height}
          backgroundColor={theme().background}
          flexDirection="column"
        >
          <DiffViewerHeader
            fileCount={files().length}
            view={effectiveView()}
            focus={focus()}
            splitAvailable={splitAvailable()}
            theme={theme}
          />
          <box flexGrow={1} flexDirection="row" minHeight={0}>
            <Show when={showFileTree()}>
              <DiffViewerFileTree
                files={files()}
                width={FILE_TREE_WIDTH}
                expandedNodes={expandedNodes()}
                highlightedNode={highlightedNode()}
                selectedFileIndex={selectedFileIndex()}
                focused={focus() === "files"}
                onRowClick={handleRowClick}
              />
            </Show>
            <scrollbox
              ref={(el: ScrollBoxRenderable) => {
                scrollRef = el
              }}
              flexGrow={1}
              minHeight={0}
              verticalScrollbarOptions={{ visible: true }}
              horizontalScrollbarOptions={{ visible: false }}
            >
              <Switch>
                <Match when={files().length === 0}>
                  <box paddingLeft={2} paddingTop={1}>
                    <text fg={theme().textMuted}>No changes</text>
                  </box>
                </Match>
                <Match when={files().length > 0}>
                  <For each={visibleFiles()}>
                    {(file, index) => (
                      <DiffFileEntry
                        file={file}
                        showSeparator={index() > 0}
                        view={effectiveView()}
                        syntax={syntax()}
                      />
                    )}
                  </For>
                </Match>
              </Switch>
            </scrollbox>
          </box>
          <DiffViewerFooter theme={theme} splitAvailable={splitAvailable()} />
        </box>
      </Portal>
    </Show>
  )
}

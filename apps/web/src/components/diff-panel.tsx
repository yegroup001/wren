import type { Diff, SnapshotFileDiff } from "@wren/protocol"
import { createMemo, createSignal, For, Show } from "solid-js"

function FileDiffView(props: { readonly file: SnapshotFileDiff }) {
  const lines = createMemo(() => {
    const patch = props.file.patch ?? ""
    return patch.split("\n")
  })
  return (
    <div class="file-diff">
      <div class="file-diff-path">
        {props.file.path}
        <span class="file-diff-stats">
          <span class="diff-add-count">+{props.file.added}</span>{" "}
          <span class="diff-del-count">-{props.file.removed}</span>
        </span>
      </div>
      <pre class="file-diff-body">
        <For each={lines()}>
          {(line) => {
            const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"
            return (
              <div class={`diff-line ${kind}`}>
                <span class="diff-line-text">{line === "" ? " " : line}</span>
              </div>
            )
          }}
        </For>
      </pre>
    </div>
  )
}

export function DiffPanel(props: { readonly diff: Diff | undefined }) {
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>(undefined)

  const selectedFile = createMemo(() => {
    const files = props.diff?.files ?? []
    const path = selectedPath()
    return files.find((file) => file.path === path) ?? files[0]
  })

  return (
    <div class="diff-panel">
      <Show when={(props.diff?.files.length ?? 0) === 0}>
        <div class="sidebar-empty">No file changes yet</div>
      </Show>
      <For each={props.diff?.files ?? []}>
        {(file) => (
          <button
            type="button"
            classList={{ "diff-file-row-active": selectedFile()?.path === file.path }}
            class="diff-file-row"
            onClick={() => setSelectedPath(file.path)}
          >
            <span class="diff-file-name">{file.path}</span>
            <span class="file-diff-stats">
              <span class="diff-add-count">+{file.added}</span>{" "}
              <span class="diff-del-count">-{file.removed}</span>
            </span>
          </button>
        )}
      </For>
      <Show when={selectedFile()}>{(file) => <FileDiffView file={file()} />}</Show>
    </div>
  )
}

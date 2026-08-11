import type { SnapshotFileDiff } from "@wren/protocol"
import { For, type JSX, Show } from "solid-js"
import { useStore } from "../context/store"
import { useTheme } from "../context/theme"

export function DiffPanel(props: { sessionId: string }): JSX.Element {
  const store = useStore()
  const { theme } = useTheme()

  const files = (): SnapshotFileDiff[] => {
    const diff = store.store.diffs[props.sessionId]
    return diff?.files ?? []
  }

  return (
    <Show when={files().length > 0} fallback={<text fg={theme().textMuted}>No file changes</text>}>
      <box flexDirection="column" flexShrink={0} gap={0}>
        <For each={files()}>
          {(file) => (
            <box flexDirection="row" gap={1} height={1}>
              <text fg={theme().text} wrapMode="none" flexGrow={1}>
                {file.path}
              </text>
              <text fg={theme().diffAdded}>{`+${file.added}`}</text>
              <text fg={theme().diffRemoved}>{`-${file.removed}`}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

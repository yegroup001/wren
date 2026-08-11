import type { Todo } from "@wren/protocol"
import { For, type JSX } from "solid-js"
import { useTheme } from "../context/theme"

export function TodoList(props: { todos: Todo[] }): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.todos}>{(todo) => <TodoItem todo={todo} />}</For>
    </box>
  )
}

function TodoItem(props: { todo: Todo }): JSX.Element {
  const { theme } = useTheme()

  const marker = (): string => {
    switch (props.todo.status) {
      case "completed":
        return "\u2713"
      case "in_progress":
        return "\u2022"
      case "pending":
        return " "
      default:
        return "?"
    }
  }

  const color = (): string => {
    switch (props.todo.status) {
      case "completed":
        return theme().success
      case "in_progress":
        return theme().warning
      case "pending":
        return theme().textMuted
      default:
        return theme().textMuted
    }
  }

  const label = (): string => {
    if (props.todo.status === "in_progress" && props.todo.activeForm) {
      return props.todo.activeForm
    }
    return props.todo.content
  }

  return (
    <box flexDirection="row" gap={0}>
      <text fg={color()}>{`[${marker()}] `}</text>
      <text fg={theme().text} wrapMode="word">
        {label()}
      </text>
    </box>
  )
}

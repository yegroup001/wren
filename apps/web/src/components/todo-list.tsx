import type { Todo } from "@wren/protocol"
import { For, Show } from "solid-js"

export function TodoList(props: { readonly todos: readonly Todo[] }) {
  return (
    <div class="todo-list">
      <Show when={props.todos.length === 0}>
        <div class="sidebar-empty">No todos yet</div>
      </Show>
      <For each={props.todos}>
        {(todo) => (
          <div class={`todo-item ${todo.status}`} title={todo.activeForm}>
            <span class="todo-check">{todo.status === "completed" ? "✓" : "○"}</span>
            <span class="todo-content">{todo.content}</span>
          </div>
        )}
      </For>
    </div>
  )
}

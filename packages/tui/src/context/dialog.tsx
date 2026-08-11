import type { Accessor, JSX, ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"

// Phase 7 will integrate this into: theme switcher, help screen, session rename, status dialog.
// DialogHost is rendered in the app root (app.tsx) and pushes "modal" keymap mode
// while any entry is on the stack, so base bindings are suppressed automatically.

export type DialogType = "select" | "confirm" | "prompt" | "alert" | "custom"

export type DialogSelectOption<T = string> = {
  readonly title: string
  readonly value: T
  readonly description?: string
  readonly disabled?: boolean
}

export type DialogSelectProps<T = string> = {
  readonly title: string
  readonly options: readonly DialogSelectOption<T>[]
  readonly placeholder?: string
}

export type DialogConfirmProps = {
  readonly title: string
  readonly message: string
  readonly label?: string
}

export type DialogPromptProps = {
  readonly title: string
  readonly description?: string
  readonly placeholder?: string
  readonly value?: string
}

export type DialogAlertProps = {
  readonly title: string
  readonly message: string
}

export type DialogEntry = {
  readonly id: number
  readonly type: DialogType
  readonly title: string
  readonly message?: string
  readonly label?: string
  readonly description?: string
  readonly placeholder?: string
  readonly value?: string
  readonly options?: readonly DialogSelectOption<unknown>[]
  readonly resolve: (value: unknown) => void
  readonly onClose?: () => void
}

export type DialogResult<T> = T | undefined

export type DialogContext = {
  readonly stack: Accessor<readonly DialogEntry[]>
  readonly pop: () => void
  readonly clear: () => void
  readonly resolve: (entry: DialogEntry, value: unknown) => void
  readonly confirm: (title: string, message: string, label?: string) => Promise<boolean | undefined>
  readonly prompt: (
    title: string,
    opts?: Omit<DialogPromptProps, "title">,
  ) => Promise<string | undefined>
  readonly alert: (title: string, message: string) => Promise<void>
  readonly select: <T = string>(
    title: string,
    options: readonly DialogSelectOption<T>[],
  ) => Promise<DialogResult<T>>
}

let dialogIdCounter = 0

const { use, provider } = createSimpleContext<DialogContext>({
  name: "Dialog",
  init: () => {
    const [stack, setStack] = createStore<DialogEntry[]>([])

    function pushEntry(entry: Omit<DialogEntry, "id" | "resolve">): Promise<unknown> {
      return new Promise<unknown>((resolve) => {
        const id = ++dialogIdCounter
        const fullEntry: DialogEntry = { id, ...entry, resolve }
        setStack(
          produce((draft) => {
            draft.push(fullEntry)
          }),
        )
      })
    }

    function removeEntry(id: number): void {
      setStack(
        produce((draft) => {
          const idx = draft.findIndex((e) => e.id === id)
          if (idx !== -1) draft.splice(idx, 1)
        }),
      )
    }

    function resolveEntry(entry: DialogEntry, value: unknown): void {
      entry.resolve(value)
      entry.onClose?.()
      removeEntry(entry.id)
    }

    return {
      stack: () => stack,
      pop: () => {
        const last = stack[stack.length - 1]
        if (last !== undefined) {
          resolveEntry(last, undefined)
        }
      },
      clear: () => {
        setStack(
          produce((draft) => {
            for (const entry of draft) {
              entry.resolve(undefined)
              entry.onClose?.()
            }
            draft.length = 0
          }),
        )
      },
      resolve: resolveEntry,
      confirm: (title, message, label) =>
        pushEntry({ type: "confirm", title, message, label }) as Promise<boolean | undefined>,
      prompt: (title, opts) =>
        pushEntry({ type: "prompt", title, ...opts }) as Promise<string | undefined>,
      alert: (title, message) => pushEntry({ type: "alert", title, message }) as Promise<void>,
      select: <T = string>(title: string, options: readonly DialogSelectOption<T>[]) =>
        pushEntry({ type: "select", title, options }) as Promise<DialogResult<T>>,
    }
  },
})

export const useDialog = use

export function DialogProvider(props: ParentProps): JSX.Element {
  return provider(props)
}

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import {
  createContext,
  createMemo,
  type JSX,
  onCleanup,
  type ParentProps,
  Show,
  useContext,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"

export type ToastVariant = "info" | "success" | "warning" | "error"

export type ToastOptions = {
  readonly title?: string
  readonly message: string
  readonly variant: ToastVariant
  readonly duration?: number
}

export type ToastContext = {
  readonly currentToast: () => ToastOptions | null
  readonly show: (options: Omit<ToastOptions, "variant"> & { variant?: ToastVariant }) => void
  readonly error: (err: unknown) => void
  readonly dismiss: () => void
}

const ToastCtx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps): JSX.Element {
  const [store, setStore] = createStore<{ current: ToastOptions | null }>({ current: null })
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  function dismiss(): void {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
      timeoutHandle = undefined
    }
    setStore("current", null)
  }

  function show(options: Omit<ToastOptions, "variant"> & { variant?: ToastVariant }): void {
    const toast: ToastOptions = {
      title: options.title,
      message: options.message,
      variant: options.variant ?? "info",
      duration: options.duration ?? 3000,
    }
    setStore("current", toast)
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    const handle = setTimeout(() => dismiss(), toast.duration)
    handle.unref?.()
    timeoutHandle = handle
  }

  function error(err: unknown): void {
    const message = err instanceof Error ? err.message : "An error occurred"
    show({ message, variant: "error" })
  }

  onCleanup(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  })

  const context: ToastContext = {
    currentToast: () => store.current,
    show,
    error,
    dismiss,
  }

  return <ToastCtx.Provider value={context}>{props.children}</ToastCtx.Provider>
}

export function useToast(): ToastContext {
  const value = useContext(ToastCtx)
  if (value === undefined) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}

export function Toast(): JSX.Element {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const variantColor = createMemo<string>(() => {
    const current = toast.currentToast()
    if (current === null) return theme().border
    switch (current.variant) {
      case "info":
        return theme().info
      case "success":
        return theme().success
      case "warning":
        return theme().warning
      case "error":
        return theme().error
      default:
        return theme().info
    }
  })

  return (
    <Show when={toast.currentToast()}>
      {(current) => (
        <box
          position="absolute"
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme().backgroundPanel}
          borderColor={variantColor()}
          border={["left", "right"]}
        >
          <Show when={current().title}>
            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme().text}>
              {current().title}
            </text>
          </Show>
          <text fg={theme().text} wrapMode="word" width="100%">
            {current().message}
          </text>
        </box>
      )}
    </Show>
  )
}

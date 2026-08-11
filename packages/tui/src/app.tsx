import { Switch, Match, createMemo, ErrorBoundary, type JSX } from "solid-js"
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import type { Selection } from "@opentui/core"
import { render, useKeyboard } from "@opentui/solid"
import type { WrenAdapter } from "@wren/adapter"
import { RouteProvider, useRoute, type Route } from "./context/route"
import { StoreProvider, useAdapter } from "./context/store"
import { ThemeProvider, useTheme } from "./context/theme"
import { LocalProvider } from "./context/local"
import { ClipboardProvider } from "./context/clipboard"
import { PromptStashProvider } from "./context/prompt-stash"
import { DialogProvider } from "./context/dialog"
import { ModalProvider } from "./context/modal"
import { ThinkingProvider } from "./context/thinking"
import { KeymapProvider, useBindings } from "./keymap"
import { ToastProvider, Toast } from "./ui/toast"
import { DialogHost } from "./ui/dialog"
import { ModalHost } from "./components/modal-host"
import { Home } from "./routes/home"
import { Session } from "./routes/session"
import { SubagentRoute } from "./routes/subagent"
import { copyCompletedSelection } from "./selection-copy"

function ErrorFallback(props: { err: Error; reset: () => void }): JSX.Element {
  const { theme } = useTheme()
  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      process.exit(1)
    }
  })
  return (
    <box flexGrow={1} flexDirection="column" padding={2} border
      borderColor={theme().border} backgroundColor={theme().background}>
      <text fg={theme().error}>{"Wren crashed"}</text>
      <text fg={theme().text} wrapMode="word">{props.err.message}</text>
      <text fg={theme().textMuted}>{"Press 'q' or 'ctrl+c' to exit"}</text>
    </box>
  )
}

function App(): JSX.Element {
  const { route } = useRoute()
  const adapter = useAdapter()

  const sessionRoute = createMemo(() => {
    const r = route()
    return r.type === "session" ? r : undefined
  })

  const subagentRoute = createMemo(() => {
    const r = route()
    return r.type === "subagent" ? r : undefined
  })

  useBindings(() => ({
    bindings: [
      { key: "ctrl+c", desc: "Abort or exit", group: "App", cmd: () => {
        const current = route()
        if (current.type === "session") {
          const status = adapter.state.store.status[current.sessionId]
          if (status && status.type === "working") {
            void adapter.fetch(
              new Request(`http://wren.internal/session/${current.sessionId}/abort`, { method: "POST" }),
            )
          } else {
            process.exit(0)
          }
        } else {
          process.exit(0)
        }
      }},
    ],
  }))

  return (
    <ErrorBoundary fallback={(err, reset) => <ErrorFallback err={err} reset={reset} />}>
      <box flexGrow={1}>
        <Switch>
          <Match when={route().type === "home"}>
            <Home />
          </Match>
          <Match when={sessionRoute()}>
            {(r) => <Session sessionId={r().sessionId} />}
          </Match>
          <Match when={route().type === "session-list"}>
            <Home />
          </Match>
          <Match when={subagentRoute()}>
            {(r) => (
              <SubagentRoute
                sessionId={r().sessionId}
                agentId={r().agentId}
                description={r().description}
                agentStatus={r().agentStatus}
              />
            )}
          </Match>
        </Switch>
        <ModalHost />
        <DialogHost />
        <Toast />
      </box>
    </ErrorBoundary>
  )
}

export type TuiLaunchOptions = {
  readonly initialRoute?: Route
  readonly initialCwd?: string
  readonly initialModel?: string
}

export function AppRoot(props: { readonly adapter: WrenAdapter } & TuiLaunchOptions): JSX.Element {
  return (
    <RouteProvider initialRoute={props.initialRoute ?? { type: "home" }}>
      <StoreProvider adapter={props.adapter}>
        <ThemeProvider>
          <LocalProvider
            initialCwd={props.initialCwd}
            initialModel={props.initialModel}
          >
            <ClipboardProvider>
              <PromptStashProvider>
                <DialogProvider>
                <ModalProvider>
                <ToastProvider>
                  <ThinkingProvider>
                    <KeymapProvider>
                      <App />
                    </KeymapProvider>
                  </ThinkingProvider>
                </ToastProvider>
                </ModalProvider>
              </DialogProvider>
              </PromptStashProvider>
            </ClipboardProvider>
          </LocalProvider>
        </ThemeProvider>
      </StoreProvider>
    </RouteProvider>
  )
}

export async function runTui(
  adapter: WrenAdapter,
  options: TuiLaunchOptions = {},
): Promise<CliRenderer> {
  const renderer = await createCliRenderer({
    targetFps: 60,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
  })

  renderer.on("selection", (selection: Selection) => {
    copyCompletedSelection({
      selection,
      write: (value) => { process.stdout.write(value) },
      clear: () => { renderer.clearSelection() },
    })
  })

  await render(() => <AppRoot adapter={adapter} {...options} />, renderer)
  return renderer
}

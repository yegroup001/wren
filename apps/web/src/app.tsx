import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { WebStore } from "./store"
import { HomeView } from "./views/home"
import { SessionView } from "./views/session"
import { SubagentView } from "./views/subagent"

export type Route =
  | { readonly name: "home" }
  | { readonly name: "session"; readonly sessionId: string }
  | { readonly name: "subagent"; readonly sessionId: string; readonly agentId: string }

export function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "")
  const parts = hash.split("/").filter((part) => part.length > 0)
  if (parts[0] === "session" && parts[1] !== undefined) {
    return { name: "session", sessionId: decodeURIComponent(parts[1]) }
  }
  if (parts[0] === "subagent" && parts[1] !== undefined && parts[2] !== undefined) {
    return {
      name: "subagent",
      sessionId: decodeURIComponent(parts[1]),
      agentId: decodeURIComponent(parts[2]),
    }
  }
  return { name: "home" }
}

export function navigate(route: Route): void {
  const target =
    route.name === "home"
      ? "#/"
      : route.name === "session"
        ? `#/session/${encodeURIComponent(route.sessionId)}`
        : `#/subagent/${encodeURIComponent(route.sessionId)}/${encodeURIComponent(route.agentId)}`
  if (location.hash === target) return
  location.hash = target
}

function ConnectionBadge(props: { readonly store: WebStore }) {
  return (
    <span class={`connection-badge ${props.store.connection()}`} title="server connection">
      {props.store.connection()}
    </span>
  )
}

type Theme = "dark" | "light"

const THEME_KEY = "wren-theme"

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === "dark" || saved === "light") return saved
  } catch {
    // localStorage unavailable
  }
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light"
  return "dark"
}

export function App(props: { readonly store: WebStore }) {
  const [route, setRoute] = createSignal<Route>(parseHash())
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme())

  createEffect(() => {
    document.documentElement.dataset.theme = theme()
    try {
      localStorage.setItem(THEME_KEY, theme())
    } catch {
      // storage unavailable
    }
  })

  onMount(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener("hashchange", onChange)
    onCleanup(() => window.removeEventListener("hashchange", onChange))
  })

  // Scroll back to the top on route change.
  createEffect(() => {
    void route()
    window.scrollTo(0, 0)
  })

  const view = createMemo(() => {
    const current = route()
    if (current.name === "home") return <HomeView store={props.store} />
    if (current.name === "subagent") {
      return (
        <SubagentView store={props.store} sessionId={current.sessionId} agentId={current.agentId} />
      )
    }
    return <SessionView store={props.store} sessionId={current.sessionId} />
  })

  return (
    <div class="app-shell">
      <header class="app-header">
        <button type="button" class="nav-home" onClick={() => navigate({ name: "home" })}>
          Wren
        </button>
        <Show when={route().name !== "home"}>
          <button type="button" class="nav-home" onClick={() => navigate({ name: "home" })}>
            Sessions
          </button>
        </Show>
        <span class="app-header-spacer" />
        <button
          type="button"
          class="icon-btn theme-toggle"
          title="Toggle theme"
          onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
        >
          {theme() === "dark" ? "☀" : "☾"}
        </button>
        <ConnectionBadge store={props.store} />
      </header>
      <main class="app-main">{view()}</main>
    </div>
  )
}

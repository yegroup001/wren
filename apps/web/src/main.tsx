import { render } from "solid-js/web"
import "./style.css"
import { api } from "./api"
import { App } from "./app"
import { createWebStore } from "./store"

async function bootstrap(): Promise<void> {
  const store = createWebStore()
  try {
    const snapshot = await api.getState()
    store.replace(snapshot)
  } catch {
    // Server unreachable yet — the WebSocket snapshot will populate on connect.
  }
  store.connect()

  const root = document.getElementById("app")
  if (root === null) throw new Error("missing #app mount point")
  render(() => <App store={store} />, root)
}

void bootstrap()

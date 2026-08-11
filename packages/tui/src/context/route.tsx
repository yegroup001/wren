import type { SessionId } from "@wren/protocol"
import { type Accessor, createSignal, type JSX, type ParentProps } from "solid-js"
import { createSimpleContext } from "./helper"

export type Route =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionId: SessionId }
  | { readonly type: "session-list" }
  | {
      readonly type: "subagent"
      readonly sessionId: SessionId
      readonly agentId: string
      readonly description: string
      readonly agentStatus: "running" | "pending" | "completed" | "failed"
    }

export type RouteContext = {
  readonly route: Accessor<Route>
  readonly navigate: (route: Route) => void
  readonly back: () => void
}

const { use, provider } = createSimpleContext<RouteContext, { initialRoute?: Route }>({
  name: "Route",
  init: (props) => {
    const [route, setRoute] = createSignal<Route>(props.initialRoute ?? { type: "home" })
    const history: Route[] = []
    return {
      route,
      navigate: (next: Route) => {
        const current = route()
        if (next.type === "subagent") {
          history.push(current)
        } else {
          history.length = 0
        }
        setRoute(next)
      },
      back: () => {
        const previous = history.pop()
        if (previous !== undefined) setRoute(previous)
        else setRoute({ type: "home" })
      },
    }
  },
})

export const useRoute = use

export function RouteProvider(props: ParentProps<{ initialRoute?: Route }>): JSX.Element {
  return provider(props)
}

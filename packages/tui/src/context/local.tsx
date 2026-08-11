import { type Accessor, createSignal, type JSX, type ParentProps } from "solid-js"
import { createSimpleContext } from "./helper"

export type TuiPermissionMode = "default" | "plan" | "auto" | "acceptEdits" | "full"

export type LocalState = {
  readonly agent: Accessor<string>
  readonly model: Accessor<string>
  readonly variant: Accessor<string>
  readonly cwd: Accessor<string>
  readonly setAgent: (agent: string) => void
  readonly setModel: (model: string) => void
  readonly setVariant: (variant: string) => void
  readonly setCwd: (cwd: string) => void
}

const { use, provider } = createSimpleContext<
  LocalState,
  {
    initialCwd?: string
    initialModel?: string
  }
>({
  name: "Local",
  init: (props) => {
    const [agent, setAgent] = createSignal("default")
    const [model, setModel] = createSignal(props.initialModel ?? "")
    const [variant, setVariant] = createSignal("default")
    const [cwd, setCwd] = createSignal(props.initialCwd ?? process.cwd())
    return { agent, model, variant, cwd, setAgent, setModel, setVariant, setCwd }
  },
})

export const useLocal = use

export function LocalProvider(
  props: ParentProps<{
    initialCwd?: string
    initialModel?: string
  }>,
): JSX.Element {
  return provider(props)
}

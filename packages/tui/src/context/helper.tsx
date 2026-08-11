import { createContext, type JSX, type ParentProps, useContext } from "solid-js"

// createSimpleContext — factory that creates a Solid Context, a Provider
// component, and a `use()` hook that throws if used outside the provider.
// Ported from OpenCode's createSimpleContext pattern, written fresh without
// any escape hatches.

export function createSimpleContext<
  T,
  Props extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  name: string
  init: (props: Props) => T
}): {
  context: ReturnType<typeof createContext<T | undefined>>
  provider: (props: ParentProps<Props>) => JSX.Element
  use: () => T
} {
  const ctx = createContext<T>()

  const provider = (props: ParentProps<Props>): JSX.Element => {
    const value = input.init(props)
    return <ctx.Provider value={value}>{props.children}</ctx.Provider>
  }

  const use = (): T => {
    const value = useContext(ctx)
    if (value === undefined) {
      throw new Error(`${input.name} context must be used within its provider`)
    }
    return value
  }

  return { context: ctx, provider, use }
}

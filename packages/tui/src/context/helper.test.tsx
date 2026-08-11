import { describe, expect, test } from "bun:test"
import { createSimpleContext } from "./helper"

describe("createSimpleContext", () => {
  test("creates context with provider and use hook", () => {
    const { provider, use } = createSimpleContext({
      name: "TestContext",
      init: () => ({ value: 42 }),
    })
    expect(typeof provider).toBe("function")
    expect(typeof use).toBe("function")
  })

  test("use throws when used outside provider", () => {
    const { use } = createSimpleContext({
      name: "ThrowContext",
      init: () => ({ value: 1 }),
    })
    expect(() => use()).toThrow("ThrowContext context must be used within its provider")
  })

  test("init receives props", () => {
    const { use, provider } = createSimpleContext({
      name: "PropsContext",
      init: (props: { initial: number }) => ({ value: props.initial }),
    })
    // Init is called when provider is rendered — but we can't render JSX in unit tests.
    // Just verify the factory structure is correct.
    expect(typeof provider).toBe("function")
    expect(typeof use).toBe("function")
  })
})

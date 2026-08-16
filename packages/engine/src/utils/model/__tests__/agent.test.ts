import { afterEach, describe, expect, test } from "bun:test"
import type { WrenConfig } from "@wren/config-node"
import { getAgentEffort, getAgentModel } from "../agent"
import { setConfigForTests } from "../configBridge"

const config: WrenConfig = {
  defaultModel: { source: "primary", model: "main" },
    reasoning: { source: "secondary", model: "shared", effort: "high" },
  },
  agentModels: {
    analytical: { source: "secondary", model: "shared" },
  },
  sources: {
    primary: {
      type: "openai-compatible-chat",
      models: {
        main: { contextWindow: 128000, supportsThinking: true },
        fast: { contextWindow: 128000, supportsThinking: true },
      },
    },
    secondary: {
      type: "openai-compatible-chat",
      models: {
        shared: { contextWindow: 128000, supportsThinking: true, effort: "medium" },
      },
    },
  },
}

describe("agent model roles", () => {
  afterEach(() => setConfigForTests(null))

  test("retains the role source and explicit effort for same-named models", () => {
    setConfigForTests(config)

    const model = getAgentModel("reasoning", "primary/main")

    expect(model).toBe("secondary/shared")
    expect(getAgentEffort(undefined, "reasoning", model)).toBe("high")
  })

  test("falls back to the resolved model effort when a role has none", () => {
    setConfigForTests(config)

    const model = getAgentModel("standard", "primary/main")

    expect(model).toBe("secondary/shared")
    expect(getAgentEffort(undefined, "standard", model)).toBe("medium")
  })

  test("uses an object-valued agent model reference to find the configured effort", () => {
    setConfigForTests(config)

    const model = getAgentModel(undefined, "primary/main", undefined, "analytical")

    expect(model).toBe("secondary/shared")
    expect(getAgentEffort("analytical", undefined, undefined)).toBe("medium")
  })
})

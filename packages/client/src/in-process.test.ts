import { WrenApplication } from "@wren/application"
import { runTransportConformanceSuite } from "./conformance"
import { InProcessWrenClient } from "./in-process"

function createTestApp(): WrenApplication {
  return new WrenApplication({
    sessionStore: {
      save: async () => {},
      load: async () => ({ ok: false }),
      listSummaries: async () => ({ skipped: [], summaries: [] }),
      saveSessionMeta: async () => {},
      delete: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any,
    engineFactory: {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      createEngine: () => Promise.resolve({} as any),
      getDefaultModel: () => "fake/model",
      getCommands: () => [],
      getAgents: () => [],
      getAgentTranscript: async () => null,
      getEngineSessionId: () => "",
      dispose: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any,
    workspaceId: "/tmp/test",
    workspaceLabel: "Test",
  })
}

runTransportConformanceSuite("InProcessWrenClient", async () => {
  const app = createTestApp()
  return new InProcessWrenClient(app)
})

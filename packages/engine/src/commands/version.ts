import type { Command, LocalCommandCall } from "../types/command.js"
import { VERSION, BUILD_TIME } from "../utils/buildInfo.js"

const call: LocalCommandCall = async () => {
  return {
    type: "text",
    value: BUILD_TIME ? `${VERSION} (built ${BUILD_TIME})` : VERSION,
  }
}

const version = {
  type: "local",
  name: "version",
  description: "Print the version this session is running (not what autoupdate downloaded)",
  // Was Ant-only upstream; for fork subscribers we want this universally
  // available — version info is harmless and useful for bug reports.
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default version

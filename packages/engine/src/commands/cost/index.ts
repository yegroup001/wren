import { formatTotalCost } from "../../cost-tracker.js"
import type { Command, LocalCommandCall } from "../../types/command.js"

const call: LocalCommandCall = async () => {
  return { type: "text", value: formatTotalCost() }
}

const cost = {
  type: "local",
  name: "cost",
  description: "Show the total cost of the current session",
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default cost

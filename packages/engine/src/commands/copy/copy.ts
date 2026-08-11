import type { LocalCommandCall } from "../../types/command.js"
import { extractTextContent, getLastAssistantMessage } from "../../utils/messages.js"

export const call: LocalCommandCall = async (_args, context) => {
  const last = getLastAssistantMessage(context.messages)
  if (!last) {
    return { type: "text", value: "No assistant response to copy yet." }
  }
  const content = last.message.content
  const text =
    typeof content === "string"
      ? content
      : extractTextContent(content ?? [], "\n").trim()
  if (!text) {
    return { type: "text", value: "Last assistant response has no text content." }
  }
  return { type: "text", value: text }
}

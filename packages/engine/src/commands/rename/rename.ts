import type { UUID } from "node:crypto"
import { getSessionId } from "../../bootstrap/state.js"
import type { LocalCommandCall } from "../../types/command.js"
import { getMessagesAfterCompactBoundary } from "../../utils/messages.js"
import { getTranscriptPath, saveAgentName, saveCustomTitle } from "../../utils/sessionStorage.js"
import { isTeammate } from "../../utils/teammate.js"
import { generateSessionName } from "./generateSessionName.js"

export const call: LocalCommandCall = async (args, context) => {
  if (isTeammate()) {
    return {
      type: "text",
      value: "Cannot rename: This session is a swarm teammate. Teammate names are set by the team leader.",
    }
  }

  let newName: string
  if (!args || args.trim() === "") {
    const generated = await generateSessionName(
      getMessagesAfterCompactBoundary(context.messages),
      context.abortController.signal,
    )
    if (!generated) {
      return {
        type: "text",
        value: "Could not generate a name: no conversation context yet. Usage: /rename <name>",
      }
    }
    newName = generated
  } else {
    newName = args.trim()
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  await saveCustomTitle(sessionId, newName, fullPath)
  await saveAgentName(sessionId, newName, fullPath)
  context.setAppState((prev) => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: newName,
    },
  }))

  return { type: "text", value: `Session renamed to: ${newName}` }
}

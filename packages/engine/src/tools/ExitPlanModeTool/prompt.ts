// External stub for ExitPlanModeTool prompt - excludes Ant-only allowedPrompts section

// Hardcoded to avoid relative import issues in stub
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion"

export const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `Use this tool when you are in plan mode, have finished writing the plan file, and are ready to leave plan mode.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool signals that planning is complete
- If the user explicitly selected plan mode, the plan is presented for approval; otherwise plan mode exits automatically and restores the previous permission mode

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning implementation steps for work that changes code. For research tasks where you're only gathering information, searching files, reading files, or understanding the codebase, do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use ${ASK_USER_QUESTION_TOOL_NAME} first (in earlier phases)
- Once your plan is finalized, use THIS tool to finish the planning phase

**Important:** Do NOT use ${ASK_USER_QUESTION_TOOL_NAME} to ask "Is this plan okay?" or "Should I proceed?" Call ExitPlanMode instead; the runtime determines whether explicit approval is required.
`

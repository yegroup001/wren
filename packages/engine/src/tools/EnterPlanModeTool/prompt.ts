import { isPlanModeInterviewPhaseEnabled } from "src/utils/planModeV2.js"
import { ASK_USER_QUESTION_TOOL_NAME } from "../AskUserQuestionTool/prompt.js"

const WHAT_HAPPENS_SECTION = `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`

function getEnterPlanModeToolPromptExternal(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled() ? "" : WHAT_HAPPENS_SECTION

  return `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation** — Adding meaningful new functionality where the implementation path isn't obvious
2. **Multiple Valid Approaches** — The task can be solved in several different ways
3. **Code Modifications** — Changes that affect existing behavior or structure, where the user should approve the approach
4. **Architectural Decisions** — The task requires choosing between patterns or technologies
5. **Multi-File Changes** — The task will likely touch more than 2-3 files
6. **Unclear Requirements** — You need to explore before understanding the full scope
7. **User Preferences Matter** — If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode instead

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

${whatHappens}## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase
`
}

export function getEnterPlanModeToolPrompt(): string {
  return getEnterPlanModeToolPromptExternal()
}

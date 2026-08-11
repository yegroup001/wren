import { createMemo, For, type JSX, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { fuzzyMatch } from "./fuzzy"

export type SlashCommand = {
  readonly name: string
  readonly description: string
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "models", description: "Browse and select a model" },
  { name: "sessions", description: "Browse and resume sessions" },
  { name: "mode", description: "Switch permission mode (default/plan/auto/acceptEdits/full)" },
  { name: "goal", description: "Set, view, or clear the persistent thread goal" },
  { name: "agents", description: "Open agent selector" },
  { name: "theme", description: "Open theme picker" },
  { name: "doctor", description: "Show diagnostics" },
  { name: "clear", description: "Clear conversation history" },
  { name: "version", description: "Show version info" },
  { name: "help", description: "Show keybindings dialog" },
  { name: "skills", description: "Browse available skills and commands" },
  { name: "compact", description: "Compact conversation history" },
  { name: "variants", description: "Set thinking effort (low/medium/high/xhigh/max)" },
  { name: "export", description: "Export session to markdown" },
  { name: "exit", description: "Exit the application" },
  { name: "abort", description: "Abort the current turn" },
]

export type AutocompleteOption = {
  readonly display: string
  readonly description: string
  readonly value: string
}

export function isExactSlashCommand(input: string): boolean {
  const command = input.trim()
  return SLASH_COMMANDS.some((item) => command === `/${item.name}`)
}

export function filterSlashCommands(query: string): AutocompleteOption[] {
  const stripped = query.startsWith("/") ? query.slice(1) : query
  const commandPart = stripped.split(" ")[0] ?? ""
  if (commandPart.length === 0) {
    return SLASH_COMMANDS.map((cmd) => ({
      display: `/${cmd.name}`,
      description: cmd.description,
      value: `/${cmd.name} `,
    }))
  }
  const lowerPart = commandPart.toLowerCase()
  return SLASH_COMMANDS.filter((cmd) => fuzzyMatch(lowerPart, cmd.name)).map((cmd) => ({
    display: `/${cmd.name}`,
    description: cmd.description,
    value: `/${cmd.name} `,
  }))
}

export function shouldShowAutocomplete(input: string): boolean {
  return input.startsWith("/") && !input.includes(" ")
}

export function PromptAutocomplete(props: {
  options: readonly AutocompleteOption[]
  selectedIndex: number
  onSelect: (index: number) => void
}): JSX.Element {
  const { theme } = useTheme()

  const maxDisplayLen = createMemo(() =>
    props.options.reduce((max, opt) => Math.max(max, opt.display.length), 0),
  )

  return (
    <Show when={props.options.length > 0}>
      <box
        flexDirection="column"
        border
        borderColor={theme().border}
        backgroundColor={theme().backgroundPanel}
        flexShrink={0}
        maxHeight={8}
      >
        <For each={props.options}>
          {(option, index) => {
            const selected = (): boolean => index() === props.selectedIndex
            const rowBg = (): string => (selected() ? theme().selectionBg : theme().backgroundPanel)
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={rowBg()}
                onMouseUp={() => props.onSelect(index())}
              >
                <text
                  fg={selected() ? theme().selectionFg : theme().text}
                  flexShrink={0}
                  minWidth={maxDisplayLen()}
                >
                  {option.display}
                </text>
                <text fg={selected() ? theme().selectionFg : theme().textMuted} wrapMode="none">
                  {` ${option.description}`}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

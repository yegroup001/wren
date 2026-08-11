// TuiTheme — the color token contract for the Wren TUI.
// Every color used in a component must trace back to a field defined here.
// Themes are hex strings so they work directly with @opentui/solid color props.

export type TuiTheme = {
  readonly primary: string
  readonly accent: string
  readonly error: string
  readonly warning: string
  readonly success: string
  readonly info: string
  readonly tip: string
  readonly text: string
  readonly textDim: string
  readonly textMuted: string
  readonly background: string
  readonly backgroundPanel: string
  readonly backgroundElement: string
  readonly border: string
  readonly borderActive: string
  readonly selectionBg: string
  readonly selectionFg: string
  readonly diffAdded: string
  readonly diffRemoved: string
  readonly diffContext: string
  readonly diffHunkHeader: string
  readonly markdownHeading: string
  readonly markdownLink: string
  readonly markdownCode: string
  readonly markdownBlockQuote: string
  readonly markdownEmph: string
  readonly markdownStrong: string
  readonly markdownListItem: string
  readonly syntaxComment: string
  readonly syntaxKeyword: string
  readonly syntaxFunction: string
  readonly syntaxString: string
  readonly syntaxNumber: string
  readonly syntaxType: string
  readonly user: string
  readonly assistant: string
  readonly thinking: string
  readonly tool: string
  readonly toolBash: string
  readonly toolRead: string
  readonly toolWrite: string
  readonly toolWeb: string
  readonly toolTodo: string
  readonly toolAgent: string
  readonly toolPlan: string
  readonly toolDefault: string
}

export type TuiThemeName = "wren" | "dracula" | "catppuccin" | "nord" | "tokyonight"

export const WREN_THEME: TuiTheme = {
  primary: "#65D6C2",
  accent: "#B8A1FF",
  error: "#FF776F",
  warning: "#F1B84B",
  success: "#5EE089",
  info: "#8AB4FF",
  tip: "#6EE0B0",
  text: "#F3F0E8",
  textDim: "#D7D8D6",
  textMuted: "#A9B0BA",
  background: "#0B0D10",
  backgroundPanel: "#12161B",
  backgroundElement: "#1A2027",
  border: "#3D4D5C",
  borderActive: "#4FC4B0",
  selectionBg: "#1A3A34",
  selectionFg: "#65D6C2",
  diffAdded: "#5EE089",
  diffRemoved: "#FF776F",
  diffContext: "#69727E",
  diffHunkHeader: "#8AB4FF",
  markdownHeading: "#65D6C2",
  markdownLink: "#8AB4FF",
  markdownCode: "#E5C07B",
  markdownBlockQuote: "#69727E",
  markdownEmph: "#B8A1FF",
  markdownStrong: "#F3F0E8",
  markdownListItem: "#8AB4FF",
  syntaxComment: "#69727E",
  syntaxKeyword: "#B8A1FF",
  syntaxFunction: "#65D6C2",
  syntaxString: "#5EE089",
  syntaxNumber: "#F1B84B",
  syntaxType: "#8AB4FF",
  user: "#8AB4FF",
  assistant: "#65D6C2",
  thinking: "#B8A1FF",
  tool: "#E5C07B",
  toolBash: "#E5C07B",
  toolRead: "#8AB4FF",
  toolWrite: "#5EE089",
  toolWeb: "#65D6C2",
  toolTodo: "#B8A1FF",
  toolAgent: "#89B4FA",
  toolPlan: "#D4A5D4",
  toolDefault: "#A9B0BA",
}

const DRACULA_THEME: TuiTheme = {
  primary: "#bd93f9",
  accent: "#8be9fd",
  error: "#ff5555",
  warning: "#f1fa8c",
  success: "#50fa7b",
  info: "#8be9fd",
  tip: "#50fa7b",
  text: "#f8f8f2",
  textDim: "#C8CEDC",
  textMuted: "#7a8ab8",
  background: "#282a36",
  backgroundPanel: "#343746",
  backgroundElement: "#44475a",
  border: "#5a6074",
  borderActive: "#bd93f9",
  selectionBg: "#44475a",
  selectionFg: "#bd93f9",
  diffAdded: "#50fa7b",
  diffRemoved: "#ff5555",
  diffContext: "#6272a4",
  diffHunkHeader: "#8be9fd",
  markdownHeading: "#bd93f9",
  markdownLink: "#8be9fd",
  markdownCode: "#f1fa8c",
  markdownBlockQuote: "#6272a4",
  markdownEmph: "#ff79c6",
  markdownStrong: "#f8f8f2",
  markdownListItem: "#8be9fd",
  syntaxComment: "#6272a4",
  syntaxKeyword: "#ff79c6",
  syntaxFunction: "#50fa7b",
  syntaxString: "#f1fa8c",
  syntaxNumber: "#bd93f9",
  syntaxType: "#8be9fd",
  user: "#8be9fd",
  assistant: "#50fa7b",
  thinking: "#ff79c6",
  tool: "#f1fa8c",
  toolBash: "#f1fa8c",
  toolRead: "#8be9fd",
  toolWrite: "#50fa7b",
  toolWeb: "#ffb86c",
  toolTodo: "#bd93f9",
  toolAgent: "#ff79c6",
  toolPlan: "#bd93f9",
  toolDefault: "#7a8ab8",
}

const CATPPUCCIN_THEME: TuiTheme = {
  primary: "#cba6f7",
  accent: "#89dceb",
  error: "#f38ba8",
  warning: "#fab387",
  success: "#a6e3a1",
  info: "#89b4fa",
  tip: "#a6e3a1",
  text: "#cdd6f4",
  textDim: "#B7BFDB",
  textMuted: "#9399b3",
  background: "#1e1e2e",
  backgroundPanel: "#313244",
  backgroundElement: "#45475a",
  border: "#585b70",
  borderActive: "#cba6f7",
  selectionBg: "#45475a",
  selectionFg: "#cba6f7",
  diffAdded: "#a6e3a1",
  diffRemoved: "#f38ba8",
  diffContext: "#7f849c",
  diffHunkHeader: "#89b4fa",
  markdownHeading: "#cba6f7",
  markdownLink: "#89dceb",
  markdownCode: "#fab387",
  markdownBlockQuote: "#7f849c",
  markdownEmph: "#f5c2e7",
  markdownStrong: "#cdd6f4",
  markdownListItem: "#89b4fa",
  syntaxComment: "#7f849c",
  syntaxKeyword: "#cba6f7",
  syntaxFunction: "#a6e3a1",
  syntaxString: "#fab387",
  syntaxNumber: "#cba6f7",
  syntaxType: "#89dceb",
  user: "#89b4fa",
  assistant: "#a6e3a1",
  thinking: "#f5c2e7",
  tool: "#fab387",
  toolBash: "#fab387",
  toolRead: "#89b4fa",
  toolWrite: "#a6e3a1",
  toolWeb: "#89dceb",
  toolTodo: "#cba6f7",
  toolAgent: "#f5c2e7",
  toolPlan: "#cba6f7",
  toolDefault: "#9399b3",
}

const NORD_THEME: TuiTheme = {
  primary: "#88c0d0",
  accent: "#8fbcbb",
  error: "#bf616a",
  warning: "#ebcb8b",
  success: "#a3be8c",
  info: "#81A1C1",
  tip: "#A3BE8C",
  text: "#eceff4",
  textDim: "#C7CED9",
  textMuted: "#8B98AD",
  background: "#2e3440",
  backgroundPanel: "#3b4252",
  backgroundElement: "#434c5e",
  border: "#576577",
  borderActive: "#88c0d0",
  selectionBg: "#434c5e",
  selectionFg: "#88c0d0",
  diffAdded: "#a3be8c",
  diffRemoved: "#bf616a",
  diffContext: "#4c566a",
  diffHunkHeader: "#81a1c1",
  markdownHeading: "#88c0d0",
  markdownLink: "#8fbcbb",
  markdownCode: "#ebcb8b",
  markdownBlockQuote: "#4c566a",
  markdownEmph: "#b48ead",
  markdownStrong: "#eceff4",
  markdownListItem: "#81a1c1",
  syntaxComment: "#4c566a",
  syntaxKeyword: "#81a1c1",
  syntaxFunction: "#8fbcbb",
  syntaxString: "#a3be8c",
  syntaxNumber: "#b48ead",
  syntaxType: "#8fbcbb",
  user: "#81a1c1",
  assistant: "#8fbcbb",
  thinking: "#b48ead",
  tool: "#ebcb8b",
  toolBash: "#ebcb8b",
  toolRead: "#81a1c1",
  toolWrite: "#a3be8c",
  toolWeb: "#5E81AC",
  toolTodo: "#D08770",
  toolAgent: "#B48EAD",
  toolPlan: "#88c0d0",
  toolDefault: "#8B98AD",
}

const TOKYONIGHT_THEME: TuiTheme = {
  primary: "#7aa2f7",
  accent: "#7dcfff",
  error: "#f7768e",
  warning: "#e0af68",
  success: "#9ece6a",
  info: "#7aa2f7",
  tip: "#9ECE6A",
  text: "#c0caf5",
  textDim: "#A6B1D8",
  textMuted: "#7B88A8",
  background: "#1a1b26",
  backgroundPanel: "#24283b",
  backgroundElement: "#414868",
  border: "#565f89",
  borderActive: "#7aa2f7",
  selectionBg: "#33467C",
  selectionFg: "#7dcfff",
  diffAdded: "#9ece6a",
  diffRemoved: "#f7768e",
  diffContext: "#565f89",
  diffHunkHeader: "#7dcfff",
  markdownHeading: "#7aa2f7",
  markdownLink: "#7dcfff",
  markdownCode: "#e0af68",
  markdownBlockQuote: "#565f89",
  markdownEmph: "#bb9af7",
  markdownStrong: "#c0caf5",
  markdownListItem: "#7dcfff",
  syntaxComment: "#565f89",
  syntaxKeyword: "#bb9af7",
  syntaxFunction: "#7aa2f7",
  syntaxString: "#9ece6a",
  syntaxNumber: "#ff9e64",
  syntaxType: "#7dcfff",
  user: "#7aa2f7",
  assistant: "#9ece6a",
  thinking: "#bb9af7",
  tool: "#e0af68",
  toolBash: "#e0af68",
  toolRead: "#7aa2f7",
  toolWrite: "#9ece6a",
  toolWeb: "#7dcfff",
  toolTodo: "#bb9af7",
  toolAgent: "#bb9af7",
  toolPlan: "#7dcfff",
  toolDefault: "#7B88A8",
}

export const BUILT_IN_THEMES: Readonly<Record<TuiThemeName, TuiTheme>> = {
  wren: WREN_THEME,
  dracula: DRACULA_THEME,
  catppuccin: CATPPUCCIN_THEME,
  nord: NORD_THEME,
  tokyonight: TOKYONIGHT_THEME,
}

export const DEFAULT_THEME: TuiTheme = WREN_THEME

export const THEME_NAMES: readonly TuiThemeName[] = Object.keys(BUILT_IN_THEMES) as TuiThemeName[]

export function getTheme(name: string): TuiTheme | undefined {
  return BUILT_IN_THEMES[name as TuiThemeName]
}

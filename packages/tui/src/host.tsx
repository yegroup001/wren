// ---------------------------------------------------------------------------
// TuiHost — injected host capabilities for the TUI
//
// The TUI needs some Node/terminal capabilities (clipboard, external editor,
// file read, export save, exit control, etc.) that don't belong in the
// browser-safe @wren/tui package. These are supplied by apps/cli.
// ---------------------------------------------------------------------------

export interface TuiHost {
  requestExit(): void
  clipboardRead(): Promise<string | null>
  clipboardWrite(text: string): Promise<void>
  saveExport(content: string, suggestedName: string): Promise<boolean>
  launchExternalEditor(initialText: string): Promise<string | null>
  readPastedFile(path: string): Promise<{ content: string; mimeType: string } | null>
}

// Context plumbing for TuiHost
import { createContext, type JSX, type ParentProps, useContext } from "solid-js"

const TuiHostContext = createContext<TuiHost | undefined>()

export function TuiHostProvider(props: ParentProps<{ host: TuiHost }>): JSX.Element {
  return <TuiHostContext.Provider value={props.host}>{props.children}</TuiHostContext.Provider>
}

export function useTuiHost(): TuiHost {
  const host = useContext(TuiHostContext)
  if (host === undefined) {
    throw new Error("useTuiHost must be used within a TuiHostProvider")
  }
  return host
}

export function useOptionalTuiHost(): TuiHost | undefined {
  return useContext(TuiHostContext)
}

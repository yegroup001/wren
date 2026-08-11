export type CompletedSelection = {
  readonly getSelectedText: () => string
}

type SelectionCopyRequest = {
  readonly selection: CompletedSelection
  readonly write: (value: string) => void
  readonly clear: () => void
}

export function copyCompletedSelection(request: SelectionCopyRequest): void {
  const text = request.selection.getSelectedText()
  if (text.length === 0) return
  const base64 = Buffer.from(text, "utf8").toString("base64")
  request.write(`\x1b]52;c;${base64}\x07`)
  request.clear()
}

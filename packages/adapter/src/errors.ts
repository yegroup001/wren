export class AdapterRouteError extends Error {
  readonly name = "AdapterRouteError"

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class AdapterSessionNotFoundError extends Error {
  readonly name = "AdapterSessionNotFoundError"

  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`)
  }
}

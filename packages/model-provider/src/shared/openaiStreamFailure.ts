export type OpenAIStreamFailureKind = "empty" | "provider_failed" | "truncated"

export type OpenAIResponseFailure = {
  readonly message: string | undefined
}

export class IncompleteOpenAIStreamError extends Error {
  readonly name = "IncompleteOpenAIStreamError"

  constructor(
    readonly kind: OpenAIStreamFailureKind,
    readonly canRetry: boolean,
    readonly providerMessage?: string,
  ) {
    super(
      providerMessage
        ? `OpenAI stream failed: ${providerMessage}`
        : "OpenAI stream ended without a finish reason",
    )
  }
}

export function readOpenAIResponseFailure(value: unknown): OpenAIResponseFailure | undefined {
  if (!isRecord(value) || value.type !== "response.failed") return undefined

  const response = value.response
  if (!isRecord(response)) return { message: undefined }

  const error = response.error
  if (!isRecord(error)) return { message: undefined }

  return {
    message: typeof error.message === "string" ? error.message : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

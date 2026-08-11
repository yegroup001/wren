export class EngineHistoryOwnershipError extends Error {
  readonly name = "EngineHistoryOwnershipError"

  constructor() {
    super("engine history snapshot belongs to a different engine")
  }
}

export class EngineHistorySnapshot {
  readonly #owner: object
  readonly #restore: () => void

  private constructor(owner: object, restore: () => void) {
    this.#owner = owner
    this.#restore = restore
  }

  static capture<T>(
    owner: object,
    messages: readonly T[],
    restore: (messages: readonly T[]) => void,
  ): EngineHistorySnapshot {
    const captured = structuredClone(messages)
    return new EngineHistorySnapshot(owner, () =>
      restore(structuredClone(captured)),
    )
  }

  restoreFor(owner: object): void {
    if (owner !== this.#owner) throw new EngineHistoryOwnershipError()
    this.#restore()
  }
}

const INTERNAL_ORIGIN = "http://wren.internal"

export function createWrenRequest(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, INTERNAL_ORIGIN), init)
}

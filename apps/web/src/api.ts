import type { ModelCatalogEntry, Session, SessionPreview, WebStateSnapshot } from "@wren/protocol"

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

const TOKEN_STORAGE_KEY = "wren-token"

export function getToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("token")
  if (fromUrl !== null && fromUrl !== "") {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl)
    } catch {
      // private mode etc. — token still works for this page load
    }
    return fromUrl
  }
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined) headers.set("content-type", "application/json")
  if (token !== "") headers.set("x-wren-token", token)
  const response = await fetch(`/api${path}`, { ...init, headers })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new ApiError(response.status, text === "" ? response.statusText : text)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function requestText(path: string): Promise<string> {
  const token = getToken()
  const headers = new Headers()
  if (token !== "") headers.set("x-wren-token", token)
  const response = await fetch(`/api${path}`, { headers })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new ApiError(response.status, text === "" ? response.statusText : text)
  }
  return response.text()
}

export const api = {
  getState: (): Promise<WebStateSnapshot> => request("/state"),

  getModels: (): Promise<{ entries: readonly ModelCatalogEntry[] }> => request("/models"),

  listSessions: (): Promise<Session[]> => request("/session"),

  createSession: (body: {
    cwd: string
    modelId?: string
    permissionMode?: string
    effort?: string
  }): Promise<Session> => request("/session", { method: "POST", body: JSON.stringify(body) }),

  getSession: (sessionId: string): Promise<Session> => request(`/session/${sessionId}`),

  renameSession: (sessionId: string, title: string): Promise<{ ok: true; title: string }> =>
    request(`/session/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title }) }),

  deleteSession: (sessionId: string): Promise<{ ok: true }> =>
    request(`/session/${sessionId}`, { method: "DELETE" }),

  getMessages: <T>(sessionId: string): Promise<T[]> => request(`/session/${sessionId}/messages`),

  sendMessage: (
    sessionId: string,
    prompt: string,
    editMessageId?: string,
  ): Promise<{ ok: true; queued?: boolean }> =>
    request(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({
        prompt,
        ...(editMessageId !== undefined && { editMessageId }),
      }),
    }),

  retry: (sessionId: string): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/retry`, { method: "POST" }),

  abort: (sessionId: string): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/abort`, { method: "POST" }),

  clear: (sessionId: string): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/clear`, { method: "POST" }),

  setModel: (
    sessionId: string,
    modelId: string,
  ): Promise<{ ok: true; modelId: string; appliesTo: "current" | "next_turn" }> =>
    request(`/session/${sessionId}/model`, {
      method: "POST",
      body: JSON.stringify({ modelId }),
    }),

  testModel: (
    sessionId: string,
    modelId: string,
  ): Promise<{ ok: true; modelId: string; effectiveModelId: string }> =>
    request(`/session/${sessionId}/model/test`, {
      method: "POST",
      body: JSON.stringify({ modelId }),
    }),

  setPermissionMode: (sessionId: string, permissionMode: string): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/permission-mode`, {
      method: "POST",
      body: JSON.stringify({ permissionMode }),
    }),

  setEffort: (
    sessionId: string,
    effort: "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/effort`, { method: "POST", body: JSON.stringify({ effort }) }),

  setGoal: (sessionId: string, action: string, objective?: string): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/goal`, {
      method: "POST",
      body: JSON.stringify({ action, ...(objective !== undefined && { objective }) }),
    }),

  getGoalStatus: (
    sessionId: string,
  ): Promise<{ goal: { objective: string; maxTurns?: number } | null; maxTurns?: number }> =>
    request(`/session/${sessionId}/goal`, {
      method: "POST",
      body: JSON.stringify({ action: "status" }),
    }),

  getContext: (
    sessionId: string,
  ): Promise<{ messageCount: number; totalChars: number; estimatedTokens: number }> =>
    request(`/session/${sessionId}/context`),

  getExportText: (sessionId: string): Promise<string> =>
    requestText(`/session/${sessionId}/export`),

  getSubagent: (sessionId: string, agentId: string): Promise<{ messages: unknown[] }> =>
    request(`/session/${sessionId}/subagent/${agentId}`),

  respondPermission: (
    sessionId: string,
    permissionId: string,
    response: "once" | "session" | "deny",
  ): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/permission/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),

  respondQuestion: (
    sessionId: string,
    questionId: string,
    answers: string[],
    rejected?: boolean,
  ): Promise<{ ok: true }> =>
    request(`/session/${sessionId}/question/${questionId}`, {
      method: "POST",
      body: JSON.stringify({ answers, ...(rejected !== undefined && { rejected }) }),
    }),

  getConfig: (): Promise<{
    model: string
    providers: string[]
    permissionMode: string
    agents: string[]
    diagnostics: unknown
    commands: { name: string; description: string; loadedFrom: string; whenToUse: string }[]
  }> => request("/config"),

  setDefaultModel: (modelId: string): Promise<{ ok: true; modelId: string; scope: string }> =>
    request("/config/default-model", {
      method: "POST",
      body: JSON.stringify({ modelId, scope: "user" }),
    }),
}

export type ConfigResponse = Awaited<ReturnType<typeof api.getConfig>>

export function previewFor(
  sessionId: string,
  previews: Record<string, SessionPreview>,
): string | undefined {
  return previews[sessionId]?.text
}

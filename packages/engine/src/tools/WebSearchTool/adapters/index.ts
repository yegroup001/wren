/**
 * Search adapter factory — selects the appropriate backend.
 *
 * Priority (highest first):
 *   1. WEB_SEARCH_ADAPTER environment variable (explicit override)
 *   2. settings.webSearchAdapter (user-configurable via /web-tools)
 *   3. Auto-detect from available API keys / settings
 *   4. Default: bing (no key required)
 */

import { getSettings_DEPRECATED } from "src/utils/settings/settings.js"
import { ApiSearchAdapter } from "./apiAdapter.js"
import { BingSearchAdapter } from "./bingAdapter.js"
import { BraveSearchAdapter } from "./braveAdapter.js"
import { ExaSearchAdapter } from "./exaAdapter.js"
import { TavilySearchAdapter } from "./tavilyAdapter.js"
import type { WebSearchAdapter } from "./types.js"

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from "./types.js"

export type SearchAdapterKey = "api" | "bing" | "brave" | "exa" | "tavily"

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterKey: SearchAdapterKey | null = null

function detectAdapterKey(): SearchAdapterKey {
  const settings = getSettings_DEPRECATED() as Record<string, unknown> & {
    tavilyEndpointUrl?: string
    braveApiKey?: string
    exaApiKey?: string
  }

  // 1. API adapter (Anthropic server-side web_search_20250305) — no key needed,
  //    works when the provider supports server-side tools.
  //    Only use when not explicitly overridden.
  // 2. Tavily — needs endpoint URL (kept for backward compat)
  if (settings.tavilyEndpointUrl?.trim()) return "tavily"

  // 3. Brave — needs API key (settings or env)
  if (settings.braveApiKey?.trim()) return "brave"
  for (const envVar of ["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"]) {
    if (process.env[envVar]?.trim()) return "brave"
  }

  // 4. Exa — needs API key
  if (settings.exaApiKey?.trim()) return "exa"
  if (process.env.EXA_API_KEY?.trim()) return "exa"

  // 5. Default: Tavily adapter — uses a free proxy endpoint, no API key needed.
  return "tavily"
}

/** Returns true if any search backend is configured and usable. */
export function isWebSearchAvailable(): boolean {
  // Bing adapter is always available — no API key required.
  return true
}

export function createAdapter(): WebSearchAdapter {
  // 1. Explicit env override
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  // 2. Settings preference (set via /web-tools panel)
  const settingsAdapter = getSettings_DEPRECATED().webSearchAdapter
  // 3. Auto-detect from available keys/settings
  const detectedKey = detectAdapterKey()

  const adapterKey: SearchAdapterKey =
    envAdapter === "api" ||
    envAdapter === "bing" ||
    envAdapter === "brave" ||
    envAdapter === "exa" ||
    envAdapter === "tavily"
      ? envAdapter
      : settingsAdapter === "api" ||
          settingsAdapter === "bing" ||
          settingsAdapter === "brave" ||
          settingsAdapter === "exa" ||
          settingsAdapter === "tavily"
        ? settingsAdapter
        : detectedKey

  if (cachedAdapter && cachedAdapterKey === adapterKey) return cachedAdapter

  switch (adapterKey) {
    case "api":
      cachedAdapter = new ApiSearchAdapter()
      break
    case "bing":
      cachedAdapter = new BingSearchAdapter()
      break
    case "brave":
      cachedAdapter = new BraveSearchAdapter()
      break
    case "exa":
      cachedAdapter = new ExaSearchAdapter()
      break
    case "tavily":
    default:
      cachedAdapter = new TavilySearchAdapter()
      break
  }

  cachedAdapterKey = adapterKey
  return cachedAdapter
}


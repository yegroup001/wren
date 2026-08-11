import type { LocalCommandCall } from "../../types/command.js"
import { getGlobalConfig, saveGlobalConfig } from "../../utils/config.js"
import { getWrenConfigSafe, patchWrenConfig } from "../../utils/model/configBridge.js"
import {
  getLanguageDisplayName,
  getResolvedLanguage,
  type PreferredLanguage,
} from "../../utils/language.js"

const VALID_LANGS: readonly PreferredLanguage[] = ["en", "zh", "auto"]

export const call: LocalCommandCall = async (args) => {
  const arg = args.trim().toLowerCase()

  if (!arg) {
    const pref =
      getWrenConfigSafe()?.preferredLanguage ?? getGlobalConfig().preferredLanguage ?? "auto"
    const resolved = getResolvedLanguage()
    const suffix = pref === "auto" ? ` → ${getLanguageDisplayName(resolved)}` : ""
    return { type: "text", value: `Language: ${getLanguageDisplayName(pref)}${suffix}` }
  }

  if (!VALID_LANGS.includes(arg as PreferredLanguage)) {
    return { type: "text", value: `Invalid language "${arg}". Use: en, zh, or auto` }
  }

  const lang = arg as PreferredLanguage
  const patched = await patchWrenConfig({ preferredLanguage: lang })
  if (!patched) {
    saveGlobalConfig((current) => ({ ...current, preferredLanguage: lang }))
  }

  const resolved = getResolvedLanguage()
  const suffix = lang === "auto" ? ` → ${getLanguageDisplayName(resolved)}` : ""
  return { type: "text", value: `Language set to ${getLanguageDisplayName(lang)}${suffix}` }
}

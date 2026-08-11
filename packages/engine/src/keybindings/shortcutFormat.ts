import { loadKeybindingsSync } from "./loadUserBindings.js"
import { getBindingDisplayText } from "./resolver.js"
import type { KeybindingContextName } from "./types.js"

// TODO(keybindings-migration): Remove fallback parameter after migration is
// complete and we've confirmed no 'keybinding_fallback_used' events are being
// logged. The fallback exists as a safety net during migration - if bindings
// fail to load or an action isn't found, we fall back to hardcoded values.
// Once stable, callers should be able to trust that getBindingDisplayText
// always returns a value for known actions, and we can remove this defensive
// pattern.

// Track which action+context pairs have already logged a fallback event
// to avoid duplicate events from repeated calls in non-React contexts.
const LOGGED_FALLBACKS = new Set<string>()

/**
 * Get the display text for a configured shortcut without React hooks.
 * Use this in non-React contexts (commands, services, etc.).
 *
 * This lives in its own module (not useShortcutDisplay.ts) so that
 * non-React callers like query/stopHooks.ts don't pull React into their
 * module graph via the sibling hook.
 *
 * @param action - The action name (e.g., 'app:toggleTranscript')
 * @param context - The keybinding context (e.g., 'Global')
 * @param fallback - Fallback text if binding not found
 * @returns The configured shortcut display text
 *
 * @example
 * const expandShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
 * // Returns the user's configured binding, or 'ctrl+o' as default
 */
export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const bindings = loadKeybindingsSync()
  const resolved = getBindingDisplayText(action, context, bindings) as unknown as string | undefined
  if (resolved === undefined) {
    const key = `${action}:${context}`
    if (!LOGGED_FALLBACKS.has(key)) {
      LOGGED_FALLBACKS.add(key)
    }
    return fallback
  }
  return resolved
}

// Leaf config module — intentionally minimal imports so UI components
// can read the auto-dream enabled state without dragging in the forked
// agent / task registry / message builder chain that autoDream.ts pulls in.

import { getLocalFeatureValue } from "../../utils/featureGates.js"
import { getInitialSettings } from "../../utils/settings/settings.js"

/**
 * Whether background memory consolidation should run. User setting
 * (autoDreamEnabled in settings.json) overrides the feature gate default
 * when explicitly set; otherwise falls through to wren_onyx_plover.
 */
export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) return setting
  const gb = getLocalFeatureValue<{ enabled?: unknown } | null>("wren_onyx_plover", null)
  return gb?.enabled === true
}

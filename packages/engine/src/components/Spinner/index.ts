export type { SpinnerMode } from './types.js'
export { useShimmerAnimation } from './useShimmerAnimation.js'
export { useStalledAnimation } from './useStalledAnimation.js'
export { getDefaultCharacters, interpolateColor } from './utils.js'
// Teammate components are NOT exported here - use dynamic require() to enable dead code elimination
// See REPL.tsx and Spinner.tsx for the correct import pattern

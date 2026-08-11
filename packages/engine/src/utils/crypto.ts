// Indirection point for the package.json "browser" field. When bun builds
// browser-sdk.js with --target browser, this file is swapped for
// crypto.browser.ts — avoiding a ~500KB crypto-browserify polyfill that Bun
// would otherwise inline for `import ... from "node:crypto"`. Node/bun builds use
// this file unchanged.
import { randomUUID } from "node:crypto"

export { randomUUID }

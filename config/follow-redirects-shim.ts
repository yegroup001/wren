// Bun's Error.captureStackTrace is stricter than V8 — it requires the first
// argument to be an Error instance. follow-redirects (transitive dep of axios)
// calls Error.captureStackTrace(this, this.constructor) where `this` is a
// CustomError whose prototype is `new Error()`, not a direct Error instance.
// This preload restores V8-compatible behavior to prevent the TypeError.
const originalCaptureStackTrace = Error.captureStackTrace
if (typeof originalCaptureStackTrace === "function") {
  Error.captureStackTrace = function (target: object, constructor?: Function): void {
    try {
      originalCaptureStackTrace.call(this, target, constructor)
    } catch {
      // V8 accepts any object; Bun requires an Error. Swallow the error
      // for non-Error targets — the stack trace is non-essential.
    }
  }
}

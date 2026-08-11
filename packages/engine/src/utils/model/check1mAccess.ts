import { is1mContextDisabled } from "../context.js"

// @[MODEL LAUNCH]: Add check if the new model supports 1M context
export function checkOpus1mAccess(): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return true
}

export function checkSonnet1mAccess(): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return true
}

/**
 * Tracks which tool uses were auto-approved by classifiers.
 * Populated from useCanUseTool.ts and permissions.ts, read from UserToolSuccessMessage.tsx.
 */

import { createSignal } from "./signal.js"

type ClassifierApproval = {
  classifier: "bash" | "auto-mode"
  matchedRule?: string
  reason?: string
}

const CLASSIFIER_APPROVALS = new Map<string, ClassifierApproval>()
const CLASSIFIER_CHECKING = new Set<string>()
const classifierChecking = createSignal()

export function setClassifierApproval(_toolUseID: string, _matchedRule: string): void {
  return
}

export function getClassifierApproval(_toolUseID: string): string | undefined {
  return undefined
}

export function setYoloClassifierApproval(_toolUseID: string, _reason: string): void {
  return
}

export function getYoloClassifierApproval(_toolUseID: string): string | undefined {
  return undefined
}

export function setClassifierChecking(toolUseID: string): void {
  return
}

export function clearClassifierChecking(toolUseID: string): void {
  return
}

export const subscribeClassifierChecking = classifierChecking.subscribe

export function isClassifierChecking(toolUseID: string): boolean {
  return CLASSIFIER_CHECKING.has(toolUseID)
}

export function deleteClassifierApproval(toolUseID: string): void {
  CLASSIFIER_APPROVALS.delete(toolUseID)
}

export function clearClassifierApprovals(): void {
  CLASSIFIER_APPROVALS.clear()
  CLASSIFIER_CHECKING.clear()
  classifierChecking.emit()
}

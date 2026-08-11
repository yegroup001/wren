/**
 * Semver comparison utilities that use Bun.semver when available
 * and fall back to the npm `semver` package in Node.js environments.
 *
 * Bun.semver.order() is ~20x faster than npm semver comparisons.
 * The npm semver fallback always uses { loose: true }.
 */

import * as semver from "semver"

export function gt(a: string, b: string): boolean {
  if (typeof Bun !== "undefined") {
    return Bun.semver.order(a, b) === 1
  }
  return semver.gt(a, b, { loose: true })
}

export function gte(a: string, b: string): boolean {
  if (typeof Bun !== "undefined") {
    return Bun.semver.order(a, b) >= 0
  }
  return semver.gte(a, b, { loose: true })
}

export function lt(a: string, b: string): boolean {
  if (typeof Bun !== "undefined") {
    return Bun.semver.order(a, b) === -1
  }
  return semver.lt(a, b, { loose: true })
}

export function lte(a: string, b: string): boolean {
  if (typeof Bun !== "undefined") {
    return Bun.semver.order(a, b) <= 0
  }
  return semver.lte(a, b, { loose: true })
}

export function satisfies(version: string, range: string): boolean {
  if (typeof Bun !== "undefined") {
    return Bun.semver.satisfies(version, range)
  }
  return semver.satisfies(version, range, { loose: true })
}

export function order(a: string, b: string): -1 | 0 | 1 {
  if (typeof Bun !== "undefined") {
    return Bun.semver.order(a, b)
  }
  return semver.compare(a, b, { loose: true })
}

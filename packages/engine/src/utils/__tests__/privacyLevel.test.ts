import { afterEach, describe, expect, test } from "bun:test"
import {
  getEssentialTrafficOnlyReason,
  getPrivacyLevel,
  isEssentialTrafficOnly,
  isTelemetryDisabled,
} from "../privacyLevel"

describe("getPrivacyLevel", () => {
  const originalDisableNonessential = process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
  const originalDisableTelemetry = process.env.WREN_DISABLE_TELEMETRY
  const originalEnableTelemetry = process.env.WREN_ENABLE_TELEMETRY

  afterEach(() => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.WREN_DISABLE_TELEMETRY
    delete process.env.WREN_ENABLE_TELEMETRY
    if (originalDisableNonessential !== undefined) {
      process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = originalDisableNonessential
    }
    if (originalDisableTelemetry !== undefined) {
      process.env.WREN_DISABLE_TELEMETRY = originalDisableTelemetry
    }
    if (originalEnableTelemetry !== undefined) {
      process.env.WREN_ENABLE_TELEMETRY = originalEnableTelemetry
    }
  })

  test("returns 'no-telemetry' when no env vars set (Wren default)", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.WREN_DISABLE_TELEMETRY
    delete process.env.WREN_ENABLE_TELEMETRY
    expect(getPrivacyLevel()).toBe("no-telemetry")
  })

  test("returns 'default' only with explicit WREN_ENABLE_TELEMETRY=1 opt-in", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.WREN_DISABLE_TELEMETRY
    process.env.WREN_ENABLE_TELEMETRY = "1"
    expect(getPrivacyLevel()).toBe("default")
  })

  test("returns 'essential-traffic' when WREN_DISABLE_NONESSENTIAL_TRAFFIC is set", () => {
    process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    delete process.env.WREN_DISABLE_TELEMETRY
    expect(getPrivacyLevel()).toBe("essential-traffic")
  })

  test("returns 'no-telemetry' when WREN_DISABLE_TELEMETRY is set", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.WREN_DISABLE_TELEMETRY = "1"
    expect(getPrivacyLevel()).toBe("no-telemetry")
  })

  test("'essential-traffic' takes priority over 'no-telemetry'", () => {
    process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    process.env.WREN_DISABLE_TELEMETRY = "1"
    expect(getPrivacyLevel()).toBe("essential-traffic")
  })
})

describe("isEssentialTrafficOnly", () => {
  const original = process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC

  afterEach(() => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    if (original !== undefined) process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = original
  })

  test("returns true for 'essential-traffic' level", () => {
    process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    expect(isEssentialTrafficOnly()).toBe(true)
  })

  test("returns false for 'no-telemetry' level", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.WREN_DISABLE_TELEMETRY = "1"
    expect(isEssentialTrafficOnly()).toBe(false)
  })

  test("returns false for 'default' level (opt-in)", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.WREN_ENABLE_TELEMETRY = "1"
    expect(isEssentialTrafficOnly()).toBe(false)
  })
})

describe("isTelemetryDisabled", () => {
  afterEach(() => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.WREN_DISABLE_TELEMETRY
    delete process.env.WREN_ENABLE_TELEMETRY
  })

  test("returns true for 'no-telemetry' level", () => {
    process.env.WREN_DISABLE_TELEMETRY = "1"
    expect(isTelemetryDisabled()).toBe(true)
  })

  test("returns true for 'essential-traffic' level", () => {
    process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    expect(isTelemetryDisabled()).toBe(true)
  })

  test("returns true by default (no env vars)", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.WREN_DISABLE_TELEMETRY
    delete process.env.WREN_ENABLE_TELEMETRY
    expect(isTelemetryDisabled()).toBe(true)
  })

  test("returns false only with WREN_ENABLE_TELEMETRY=1", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.WREN_DISABLE_TELEMETRY
    process.env.WREN_ENABLE_TELEMETRY = "1"
    expect(isTelemetryDisabled()).toBe(false)
  })
})

describe("getEssentialTrafficOnlyReason", () => {
  afterEach(() => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
  })

  test("returns env var name when restricted", () => {
    process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    expect(getEssentialTrafficOnlyReason()).toBe("WREN_DISABLE_NONESSENTIAL_TRAFFIC")
  })

  test("returns null when unrestricted", () => {
    delete process.env.WREN_DISABLE_NONESSENTIAL_TRAFFIC
    expect(getEssentialTrafficOnlyReason()).toBeNull()
  })
})

import { describe, expect, mock, test } from "bun:test"

mock.module("../../../utils/featureGates.js", () => ({
  getLocalFeatureValue: () => [],
}))

import { isChannelAllowlisted } from "../channelAllowlist.js"

describe("isChannelAllowlisted", () => {
  test("allows builtin weixin plugin", () => {
    expect(isChannelAllowlisted("weixin@builtin")).toBe(true)
  })

  test("rejects undefined plugin source", () => {
    expect(isChannelAllowlisted(undefined)).toBe(false)
  })
})

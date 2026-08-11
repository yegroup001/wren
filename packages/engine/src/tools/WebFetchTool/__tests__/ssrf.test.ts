import { describe, expect, test } from "bun:test"
import { isBlockedAddress } from "../ssrf.js"

describe("WebFetch SSRF address guard", () => {
  test("blocks private and metadata IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.100.100.200",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "127.0.0.1",
    ]) {
      expect(isBlockedAddress(address)).toBe(true)
    }
  })

  test("blocks private and link-local IPv6 ranges", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12::1", "fe80::1"]) {
      expect(isBlockedAddress(address)).toBe(true)
    }
  })

  test("blocks IPv4-mapped and IPv4-compatible IPv6 addresses", () => {
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true)
    expect(isBlockedAddress("0000:0000:0000:0000:0000:ffff:a9fe:a9fe")).toBe(true)
    expect(isBlockedAddress("::169.254.169.254")).toBe(true)
    expect(isBlockedAddress("::192.168.1.1")).toBe(true)
    expect(isBlockedAddress("::127.0.0.1")).toBe(true)
    expect(isBlockedAddress("::10.0.0.1")).toBe(true)
  })

  test("allows public addresses", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false)
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false)
  })
})

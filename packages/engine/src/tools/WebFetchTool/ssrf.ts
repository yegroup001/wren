import { lookup as dnsLookup } from "node:dns"
import { isIP } from "node:net"
import type { AddressFamily, LookupAddress as AxiosLookupAddress } from "axios"

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isBlockedIPv4(address)
  if (version === 6) return isBlockedIPv6(address)
  return false
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number)
  const [first, second] = parts
  if (
    parts.length !== 4 ||
    first === undefined ||
    second === undefined ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function expandIPv6Groups(address: string): number[] | null {
  let normalizedAddress = address
  let tail: number[] = []
  if (normalizedAddress.includes(".")) {
    const separator = normalizedAddress.lastIndexOf(":")
    const octets = normalizedAddress
      .slice(separator + 1)
      .split(".")
      .map(Number)
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null
    }
    const [a, b, c, d] = octets
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null
    tail = [(a << 8) | b, (c << 8) | d]
    normalizedAddress = normalizedAddress.slice(0, separator)
    // After stripping the IPv4 tail, "::a.b.c.d" leaves a single ":"
    // which should be treated as "::" (all-zero prefix)
    if (normalizedAddress === ":") normalizedAddress = "::"
  }

  const separator = normalizedAddress.indexOf("::")
  const head = (separator < 0 ? normalizedAddress : normalizedAddress.slice(0, separator))
    .split(":")
    .filter(Boolean)
  const suffix = (separator < 0 ? "" : normalizedAddress.slice(separator + 2))
    .split(":")
    .filter(Boolean)
  const fill = 8 - tail.length - head.length - suffix.length
  if (fill < 0 || (separator < 0 && fill !== 0)) return null

  const groups = [...head, ...new Array<string>(fill).fill("0"), ...suffix]
    .map((group) => Number.parseInt(group, 16))
    .concat(tail)
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null
}

function isBlockedIPv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === "::1") return true
  if (lower === "::") return true
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true

  const groups = expandIPv6Groups(lower)
  if (!groups) return false
  const first = groups[0]
  if (first !== undefined && first >= 0xfe80 && first <= 0xfebf) return true

  const mappedHigh = groups[6]
  const mappedLow = groups[7]
  const isIPv4Embedded =
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0) &&
    mappedHigh !== undefined &&
    mappedLow !== undefined
  const mappedIPv4 = isIPv4Embedded
    ? `${mappedHigh >> 8}.${mappedHigh & 0xff}.${mappedLow >> 8}.${mappedLow & 0xff}`
    : null
  return mappedIPv4 !== null && isBlockedIPv4(mappedIPv4)
}

export function ssrfGuardedLookup(
  hostname: string,
  options: object,
  callback: (
    error: Error | null,
    address: AxiosLookupAddress | AxiosLookupAddress[],
    family?: AddressFamily,
  ) => void,
): void {
  const all = "all" in options && options.all === true
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "")
  const version = isIP(normalizedHostname)

  if (version !== 0) {
    if (isBlockedAddress(normalizedHostname)) {
      callback(new Error(`Blocked private or local address: ${normalizedHostname}`), "")
      return
    }
    const family = version === 6 ? 6 : 4
    callback(null, all ? [{ address: normalizedHostname, family }] : normalizedHostname, family)
    return
  }

  dnsLookup(normalizedHostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error, "")
      return
    }
    const blocked = addresses.find(({ address }) => isBlockedAddress(address))
    if (blocked) {
      callback(new Error(`Blocked private or local address: ${blocked.address}`), "")
      return
    }
    const first = addresses[0]
    if (!first) {
      callback(new Error(`No address found for ${normalizedHostname}`), "")
      return
    }
    if (all) {
      const normalizedAddresses = addresses.map(({ address, family }) => ({
        address,
        family: family === 6 ? 6 : 4,
      })) as unknown as AxiosLookupAddress[]
      callback(null, normalizedAddresses, first.family === 6 ? 6 : 4)
    } else {
      callback(null, first.address, first.family === 6 ? 6 : 4)
    }
  })
}

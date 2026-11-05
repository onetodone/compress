import { isIPv4, isIPv6 } from 'node:net'

/** Network key used when the client address is unknown or malformed. */
export const UNKNOWN_NETWORK = 'unknown'

function groupCount(parts: string[]): number {
  return parts.reduce((count, part) => count + (part.includes('.') ? 2 : 1), 0)
}

/**
 * Returns the network a client address belongs to, for limits per network: an IPv4 address as is,
 * an IPv6 address as its /64 prefix, since one subscriber usually gets a whole /64 and can rotate
 * addresses within it at will.
 *
 * @param ip client address as Express reports it, e.g. `203.0.113.7`, `::ffff:203.0.113.7` or `2001:db8::1`
 */
export function networkOf(ip: string | undefined): string {
  if (!ip) return UNKNOWN_NETWORK
  const address = ip.replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped && isIPv4(mapped)) return mapped
  if (isIPv4(address)) return address
  if (!isIPv6(address)) return UNKNOWN_NETWORK

  const [head = '', tail] = address.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const missing = 8 - groupCount(headParts) - groupCount(tailParts)
  const groups = [...headParts, ...Array<string>(missing).fill('0'), ...tailParts]
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16))
  return `${prefix.join(':')}::/64`
}

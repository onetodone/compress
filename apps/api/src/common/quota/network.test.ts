import { describe, expect, it } from 'vitest'

import { networkOf, UNKNOWN_NETWORK } from './network.js'

describe('networkOf', () => {
  it('keeps an IPv4 address', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7')
  })

  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(networkOf('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(networkOf('::FFFF:203.0.113.7')).toBe('203.0.113.7')
  })

  it('groups IPv6 addresses of one /64 together', () => {
    expect(networkOf('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(networkOf('2001:0db8:0001:0002:abcd:ef01:2345:6789')).toBe('2001:db8:1:2::/64')
  })

  it('separates IPv6 addresses of different /64 networks', () => {
    expect(networkOf('2001:db8:1:3::1')).not.toBe(networkOf('2001:db8:1:2::1'))
  })

  it('expands a compressed prefix', () => {
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(networkOf('::1')).toBe('0:0:0:0::/64')
    expect(networkOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  })

  it('handles an IPv4 suffix in an IPv6 address', () => {
    expect(networkOf('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64')
  })

  it('falls back to one shared key for unknown or malformed addresses', () => {
    expect(networkOf(undefined)).toBe(UNKNOWN_NETWORK)
    expect(networkOf('')).toBe(UNKNOWN_NETWORK)
    expect(networkOf('not-an-ip')).toBe(UNKNOWN_NETWORK)
  })
})

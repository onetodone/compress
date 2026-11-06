import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import { isLinkCode, linkCodeId, newLinkCode, readLinkCode } from './link-codes.js'

const NOW = new Date('2026-11-06T12:00:00Z')
const later = Timestamp.fromDate(new Date(NOW.getTime() + 60_000))

describe('link codes', () => {
  it('creates distinct 22-character base64url codes', () => {
    const codes = new Set(Array.from({ length: 100 }, newLinkCode))

    expect(codes.size).toBe(100)
    for (const code of codes) expect(isLinkCode(code)).toBe(true)
  })

  it('stores a code under a hash that does not contain it', () => {
    const code = newLinkCode()

    expect(linkCodeId(code)).toBe(linkCodeId(code))
    expect(linkCodeId(code)).not.toContain(code)
    expect(linkCodeId(code)).toMatch(/^[\w-]{43}$/)
  })

  it.each(['', 'short', 'a'.repeat(23), 'Ab+/0123456789abcdefgh'])('refuses a malformed code: %j', (value) => {
    expect(isLinkCode(value)).toBe(false)
  })

  it('reads a valid code of the asked purpose', () => {
    expect(readLinkCode({ purpose: 'login', uid: 'u1', telegramId: 7, expiresAt: later }, 'login', NOW)).toEqual({
      purpose: 'login',
      uid: 'u1',
      telegramId: 7,
      label: null,
      expiresAt: later.toDate(),
    })
  })

  it('refuses a code of another purpose, an expired one and a login code without its Telegram account', () => {
    const link = { purpose: 'link', uid: 'u1', telegramId: null, expiresAt: later }

    expect(readLinkCode(link, 'login', NOW)).toBeNull()
    expect(readLinkCode({ ...link, expiresAt: Timestamp.fromDate(NOW) }, 'link', NOW)).toBeNull()
    expect(readLinkCode({ ...link, purpose: 'login' }, 'login', NOW)).toBeNull()
    expect(readLinkCode(undefined, 'link', NOW)).toBeNull()
  })
})

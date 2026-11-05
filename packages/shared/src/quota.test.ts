import { describe, expect, it } from 'vitest'

import { jobsUsedToday, utcDayKey } from './quota.js'

describe('utcDayKey', () => {
  it('uses the UTC date regardless of the local offset', () => {
    expect(utcDayKey(new Date('2026-10-21T23:30:00-02:00'))).toBe('2026-10-22')
    expect(utcDayKey(new Date('2026-10-22T00:30:00+02:00'))).toBe('2026-10-21')
  })
})

describe('jobsUsedToday', () => {
  const now = new Date('2026-10-22T12:00:00Z')

  it('returns the stored count on the same UTC day', () => {
    expect(jobsUsedToday({ dayKey: '2026-10-22', jobsToday: 3 }, now)).toBe(3)
  })

  it('resets the count when the UTC day changes', () => {
    expect(jobsUsedToday({ dayKey: '2026-10-21', jobsToday: 5 }, now)).toBe(0)
  })

  it('treats a user without a quota record as having used nothing', () => {
    expect(jobsUsedToday(undefined, now)).toBe(0)
  })
})

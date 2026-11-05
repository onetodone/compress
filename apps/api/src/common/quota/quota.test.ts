import { describe, expect, it } from 'vitest'

import { consumeQuota, currentQuota, readStoredUsage, refundQuota } from './quota.js'

const now = new Date('2026-10-22T08:00:00Z')

describe('currentQuota', () => {
  it('reports the stored count on the same UTC day', () => {
    expect(currentQuota({ dayKey: '2026-10-22', jobsToday: 2 }, 5, now)).toEqual({
      dayKey: '2026-10-22',
      used: 2,
      limit: 5,
    })
  })

  it('starts from zero after the UTC day changes', () => {
    expect(currentQuota({ dayKey: '2026-10-21', jobsToday: 5 }, 5, now).used).toBe(0)
  })

  it('rolls over at UTC midnight, not local midnight', () => {
    const stored = { dayKey: '2026-10-21', jobsToday: 3 }

    expect(currentQuota(stored, 5, new Date('2026-10-21T23:59:59.999Z')).used).toBe(3)
    expect(currentQuota(stored, 5, new Date('2026-10-22T00:00:00.000Z')).used).toBe(0)
  })

  it('reports the given limit', () => {
    expect(currentQuota(undefined, 30, now)).toEqual({ dayKey: '2026-10-22', used: 0, limit: 30 })
  })
})

describe('consumeQuota', () => {
  it('counts the first job of a new user', () => {
    expect(consumeQuota(undefined, 5, now)).toEqual({ dayKey: '2026-10-22', used: 1, limit: 5 })
  })

  it('increments the count on the same day', () => {
    expect(consumeQuota({ dayKey: '2026-10-22', jobsToday: 4 }, 5, now)?.used).toBe(5)
  })

  it('refuses a job once the daily limit is reached', () => {
    expect(consumeQuota({ dayKey: '2026-10-22', jobsToday: 5 }, 5, now)).toBeNull()
  })

  it('allows jobs again on the next UTC day after reaching the limit', () => {
    expect(consumeQuota({ dayKey: '2026-10-21', jobsToday: 5 }, 5, now)).toEqual({
      dayKey: '2026-10-22',
      used: 1,
      limit: 5,
    })
  })

  it('applies the higher limit after upgrading from an anonymous account', () => {
    expect(consumeQuota({ dayKey: '2026-10-22', jobsToday: 5 }, 30, now)?.used).toBe(6)
  })
})

describe('readStoredUsage', () => {
  it('reads the day key and counter', () => {
    expect(readStoredUsage({ dayKey: '2026-10-22', jobsToday: 1, isAnonymous: true })).toEqual({
      dayKey: '2026-10-22',
      jobsToday: 1,
    })
  })

  it('treats a missing document or missing fields as no usage', () => {
    expect(readStoredUsage(undefined)).toBeUndefined()
    expect(readStoredUsage({ isAnonymous: true })).toBeUndefined()
  })
})

describe('refundQuota', () => {
  it('gives back one job on the day it was counted', () => {
    expect(refundQuota({ dayKey: '2026-10-22', jobsToday: 3 }, '2026-10-22')).toEqual({
      dayKey: '2026-10-22',
      jobsToday: 2,
    })
  })

  it('gives nothing back once the counter belongs to another day', () => {
    expect(refundQuota({ dayKey: '2026-10-23', jobsToday: 1 }, '2026-10-22')).toBeNull()
  })

  it('never makes the counter negative', () => {
    expect(refundQuota({ dayKey: '2026-10-22', jobsToday: 0 }, '2026-10-22')).toBeNull()
    expect(refundQuota(undefined, '2026-10-22')).toBeNull()
  })
})

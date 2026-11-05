import { jobsUsedToday, type Quota, utcDayKey } from '@onetodone/image-compressor-shared'

/** Quota counters as stored in `users/{uid}`. */
export interface StoredUsage {
  dayKey: string
  jobsToday: number
}

/** Reads the quota counters from a `users/{uid}` document, ignoring missing or malformed fields. */
export function readStoredUsage(data: Record<string, unknown> | undefined): StoredUsage | undefined {
  if (typeof data?.dayKey !== 'string' || typeof data.jobsToday !== 'number') return undefined
  return { dayKey: data.dayKey, jobsToday: data.jobsToday }
}

/** Computes today's quota; counters from an earlier UTC day count as zero. */
export function currentQuota(stored: StoredUsage | undefined, limit: number, now: Date): Quota {
  return { dayKey: utcDayKey(now), used: jobsUsedToday(stored, now), limit }
}

/** Returns the quota after submitting one more job today, or `null` if the daily limit is reached. */
export function consumeQuota(stored: StoredUsage | undefined, limit: number, now: Date): Quota | null {
  const quota = currentQuota(stored, limit, now)
  return quota.used < quota.limit ? { ...quota, used: quota.used + 1 } : null
}

/**
 * Returns the counters after giving back one job counted on `dayKey`, or `null` if there is nothing
 * to give back: the counter has rolled over to another day since, or it is already zero.
 */
export function refundQuota(stored: StoredUsage | undefined, dayKey: string): StoredUsage | null {
  if (stored?.dayKey !== dayKey || stored.jobsToday <= 0) return null
  return { dayKey, jobsToday: stored.jobsToday - 1 }
}

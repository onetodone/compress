import { z } from 'zod'

/**
 * Codes in the body of a `429` response: `daily_limit` is the user's own daily quota,
 * `network_daily_limit` the limit on anonymous jobs from one network.
 */
export const quotaErrorCodeSchema = z.enum(['daily_limit', 'network_daily_limit'])

/** Why a job was refused with `429`. */
export type QuotaErrorCode = z.infer<typeof quotaErrorCodeSchema>

/**
 * Returns the UTC calendar date of `date` as `YYYY-MM-DD`, the key that daily quotas reset on.
 * @param date point in time to convert
 */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Returns how many jobs a user has already used today, treating a counter from an earlier day as zero.
 * @param stored the day key and counter saved for the user, or `undefined` if none exists yet
 * @param now current time
 */
export function jobsUsedToday(stored: { dayKey: string; jobsToday: number } | undefined, now: Date): number {
  return stored?.dayKey === utcDayKey(now) ? stored.jobsToday : 0
}

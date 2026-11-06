const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** How often the stale job cleanup runs. */
export const CLEANUP_INTERVAL_MS = HOUR_MS

/** Results are removed by the bucket lifecycle rule after 7 days. */
export const RESULT_LIFETIME_MS = 7 * DAY_MS

/**
 * Age at which a job document is deleted. One cleanup interval short of the result lifetime, so the
 * document always goes before the bucket lifecycle rule can remove its result.
 */
export const JOB_LIFETIME_MS = RESULT_LIFETIME_MS - CLEANUP_INTERVAL_MS

/**
 * Time at which a job and its files are removed.
 * @param createdAt creation time of the job
 */
export function jobExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + JOB_LIFETIME_MS)
}

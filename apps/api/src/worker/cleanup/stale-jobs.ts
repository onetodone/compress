import type { QueueConfig } from '../../common/config/config.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** How often the cleanup runs, as a cron pattern (every hour, UTC). */
export const CLEANUP_PATTERN = '0 * * * *'

/** Time between two cleanup runs. */
export const CLEANUP_INTERVAL_MS = HOUR_MS

/**
 * Upper bound of one attempt of a compression task: the work itself, which must finish within the
 * worker's stop timeout (about 90 s), plus the time BullMQ needs to notice a crashed or stalled
 * attempt (lock of 30 s, checked every 30 s).
 */
const ATTEMPT_ALLOWANCE_MS = 150_000

/** A job not uploaded within this time never will be: its presigned upload URL expired long ago. */
export const UPLOAD_LIFETIME_MS = DAY_MS

/** Results are removed by the bucket lifecycle rule after 7 days. */
const RESULT_LIFETIME_MS = 7 * DAY_MS

/**
 * Age at which a job document is deleted. One cleanup interval short of the result lifetime, so the
 * document always goes before the bucket lifecycle rule can remove its result.
 */
export const JOB_LIFETIME_MS = RESULT_LIFETIME_MS - CLEANUP_INTERVAL_MS

/**
 * Time a queued or processing job may go without an update while its compression task is still
 * retried: every attempt plus the backoff between them (doubled each time), with a margin of 100 %.
 * With 5 attempts and a backoff of 10 s this is 30 minutes.
 */
export function compressionWindowMs({ QUEUE_MAX_ATTEMPTS, QUEUE_BACKOFF_MS }: QueueConfig): number {
  const backoff = QUEUE_BACKOFF_MS * (2 ** (QUEUE_MAX_ATTEMPTS - 1) - 1)
  return 2 * (backoff + QUEUE_MAX_ATTEMPTS * ATTEMPT_ALLOWANCE_MS)
}

/** Cut-off times of one cleanup run: jobs last updated (or created) before them are stale. */
export interface StaleJobCutoffs {
  /** `awaiting_upload` jobs not updated since. */
  upload: Date
  /** `queued` and `processing` jobs not updated since. */
  compression: Date
  /** Jobs of any status created before. */
  expired: Date
}

/** Computes the cut-off times of a cleanup run that starts at `now`. */
export function staleJobCutoffs(now: Date, config: QueueConfig): StaleJobCutoffs {
  const ago = (ms: number) => new Date(now.getTime() - ms)
  return {
    upload: ago(UPLOAD_LIFETIME_MS),
    compression: ago(compressionWindowMs(config)),
    expired: ago(JOB_LIFETIME_MS),
  }
}

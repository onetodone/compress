import { describe, expect, it } from 'vitest'

import type { QueueConfig } from '../../common/config/config.js'
import { compressionWindowMs, JOB_LIFETIME_MS, staleJobCutoffs } from './stale-jobs.js'

const config: QueueConfig = {
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  QUEUE_PREFIX: 'image-compressor',
  QUEUE_MAX_ATTEMPTS: 5,
  QUEUE_BACKOFF_MS: 10_000,
}

describe('compressionWindowMs', () => {
  it('gives the default retry settings 30 minutes', () => {
    expect(compressionWindowMs(config)).toBe(30 * 60_000)
  })

  it('grows with the doubled backoff of every further attempt', () => {
    const six = compressionWindowMs({ ...config, QUEUE_MAX_ATTEMPTS: 6 })
    // One more attempt of 150 s plus a fifth backoff of 160 s, with the margin of 100 %.
    expect(six - compressionWindowMs(config)).toBe(2 * (150_000 + 160_000))
  })

  it('needs no backoff for a single attempt', () => {
    expect(compressionWindowMs({ ...config, QUEUE_MAX_ATTEMPTS: 1 })).toBe(2 * 150_000)
  })
})

describe('staleJobCutoffs', () => {
  const now = new Date('2026-11-06T12:00:00Z')

  it('treats uploads older than a day as abandoned', () => {
    expect(staleJobCutoffs(now, config).upload).toEqual(new Date('2026-11-05T12:00:00Z'))
  })

  it('treats queued jobs as stuck after the retry window', () => {
    expect(staleJobCutoffs(now, config).compression).toEqual(new Date('2026-11-06T11:30:00Z'))
  })

  it('expires jobs one hour before their results are removed from storage', () => {
    expect(JOB_LIFETIME_MS).toBe((7 * 24 - 1) * 60 * 60_000)
    expect(staleJobCutoffs(now, config).expired).toEqual(new Date('2026-10-30T13:00:00Z'))
  })
})

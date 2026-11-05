import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { RedisNetworkQuota } from '../src/api/users/redis-network-quota.js'
import { CallTimer } from '../src/common/logging/call-timer.js'
import { TEST_REDIS_URL } from './support/config.js'

describe('RedisNetworkQuota', () => {
  let redis: Redis
  let quota: RedisNetworkQuota
  const day = '2026-11-06'

  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL)
    quota = new RedisNetworkQuota(
      new Redis(TEST_REDIS_URL),
      'image-compressor-test',
      new CallTimer(10_000, new Logger('test')),
    )
  })

  afterAll(async () => {
    quota.close()
    await redis.quit()
  })

  beforeEach(() => redis.flushdb())

  it('counts reservations up to the limit', async () => {
    expect(await quota.reserve('203.0.113.7', day, 2)).toBe(true)
    expect(await quota.reserve('203.0.113.7', day, 2)).toBe(true)
    expect(await quota.reserve('203.0.113.7', day, 2)).toBe(false)

    expect(await quota.used('203.0.113.7', day)).toBe(2)
  })

  it('never passes the limit under concurrent reservations', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => quota.reserve('203.0.113.7', day, 3)))

    expect(results.filter(Boolean)).toHaveLength(3)
    expect(await quota.used('203.0.113.7', day)).toBe(3)
  })

  it('keeps networks and days apart', async () => {
    await quota.reserve('203.0.113.7', day, 1)

    expect(await quota.reserve('203.0.113.8', day, 1)).toBe(true)
    expect(await quota.reserve('203.0.113.7', '2026-11-07', 1)).toBe(true)
  })

  it('releases a reservation without going below zero', async () => {
    await quota.reserve('203.0.113.7', day, 1)

    await quota.release('203.0.113.7', day)
    await quota.release('203.0.113.7', day)

    expect(await quota.used('203.0.113.7', day)).toBe(0)
    expect(await quota.reserve('203.0.113.7', day, 1)).toBe(true)
  })

  it('lets counters expire after their day', async () => {
    await quota.reserve('203.0.113.7', day, 1)

    const ttl = await redis.ttl(`image-compressor-test:network-quota:${day}:203.0.113.7`)
    expect(ttl).toBeGreaterThan(24 * 60 * 60)
    expect(ttl).toBeLessThanOrEqual(2 * 24 * 60 * 60)
  })
})

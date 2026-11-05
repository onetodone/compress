import { Redis } from 'ioredis'

import { TEST_REDIS_URL } from './config.js'

/** Deletes every key in the test Redis database. */
export async function flushTestRedis(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
  try {
    await redis.connect()
  } catch {
    throw new Error(`Redis is not reachable at ${TEST_REDIS_URL}; start it with: dstart redis`)
  }
  try {
    await redis.flushdb()
  } finally {
    redis.disconnect()
  }
}

/** Polls `check` until it returns a value other than `undefined`, or fails after `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

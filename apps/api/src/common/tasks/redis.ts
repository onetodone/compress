import { Logger } from '@nestjs/common'
import { Redis } from 'ioredis'

/** What a Redis connection is used for; producers should fail fast, consumers wait for Redis. */
export type RedisRole = 'producer' | 'consumer'

/**
 * Opens an ioredis connection for BullMQ. BullMQ cannot load ioredis by itself in native ESM, so it
 * gets a ready-made client.
 *
 * A producer gives up on a command after one reconnect, so an API request fails instead of hanging
 * while Redis is down. A consumer retries forever, as BullMQ requires for workers.
 */
export function createRedisConnection(url: string, role: RedisRole): Redis {
  const redis = new Redis(url, {
    connectionName: `image-compressor-${role}`,
    maxRetriesPerRequest: role === 'producer' ? 1 : null,
    connectTimeout: 5000,
  })
  const logger = new Logger('Redis')
  let reported = false
  // Without a listener, ioredis prints every failed reconnect; one warning per outage is enough.
  redis.on('error', (error: Error) => {
    if (reported) return
    reported = true
    logger.warn({ role, err: { name: error.name, code: (error as { code?: string }).code } }, 'Redis is unavailable')
  })
  redis.on('ready', () => {
    if (reported) logger.log({ role }, 'Redis is available again')
    reported = false
  })
  return redis
}

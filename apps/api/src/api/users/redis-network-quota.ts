import type { Redis } from 'ioredis'

import { CallTimer } from '../../common/logging/call-timer.js'
import { NetworkQuota } from './network-quota.js'

// Counters outlive their UTC day a little, so a request at midnight never finds a fresh key early.
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60

// Check and increment in one step, so concurrent submits cannot pass the limit together.
const RESERVE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`

const RELEASE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used > 0 then redis.call('DECR', KEYS[1]) end
return 0
`

/** {@link NetworkQuota} with one counter per network and day in Redis. */
export class RedisNetworkQuota extends NetworkQuota {
  /**
   * @param redis a producer connection, closed by {@link close}
   * @param prefix key prefix of the app on a shared Redis
   */
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly timer: CallTimer,
  ) {
    super()
  }

  async used(network: string, dayKey: string): Promise<number> {
    const value = await this.timer.measure('redis', 'networkQuota.get', () => this.redis.get(this.key(network, dayKey)))
    return Number(value ?? 0)
  }

  async reserve(network: string, dayKey: string, limit: number): Promise<boolean> {
    const result = await this.timer.measure('redis', 'networkQuota.reserve', () =>
      this.redis.eval(RESERVE, 1, this.key(network, dayKey), limit, COUNTER_TTL_SECONDS),
    )
    return result === 1
  }

  async release(network: string, dayKey: string): Promise<void> {
    await this.timer.measure('redis', 'networkQuota.release', () =>
      this.redis.eval(RELEASE, 1, this.key(network, dayKey)),
    )
  }

  /** Closes the Redis connection. */
  close(): void {
    this.redis.disconnect()
  }

  private key(network: string, dayKey: string): string {
    return `${this.prefix}:network-quota:${dayKey}:${network}`
  }
}

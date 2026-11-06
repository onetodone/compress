import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'

import type { QueueConfig } from '../config/config.js'
import { CallTimer } from '../logging/call-timer.js'
import { createRedisConnection } from '../tasks/redis.js'
import { NetworkQuota } from './network-quota.js'
import { QuotaService } from './quota.service.js'
import { RedisNetworkQuota } from './redis-network-quota.js'

/** Provides {@link QuotaService} globally: the daily job quota and the per-network limit on anonymous jobs. */
@Module({})
export class QuotaModule implements OnApplicationShutdown {
  constructor(@Inject(NetworkQuota) private readonly networks: NetworkQuota) {}

  /** Keeps the network counters in the Redis of `REDIS_URL`, under `QUEUE_PREFIX`. */
  static register(config: QueueConfig): DynamicModule {
    return {
      module: QuotaModule,
      global: true,
      providers: [
        QuotaService,
        {
          provide: NetworkQuota,
          useFactory: (timer: CallTimer) =>
            new RedisNetworkQuota(createRedisConnection(config.REDIS_URL, 'producer'), config.QUEUE_PREFIX, timer),
          inject: [CallTimer],
        },
      ],
      exports: [QuotaService],
    }
  }

  onApplicationShutdown(): void {
    // Tests replace the counters with a fake that has nothing to close.
    if (this.networks instanceof RedisNetworkQuota) this.networks.close()
  }
}

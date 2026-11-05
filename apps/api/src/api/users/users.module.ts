import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'

import type { QueueConfig } from '../../common/config/config.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import { createRedisConnection } from '../../common/tasks/redis.js'
import { MeController } from './me.controller.js'
import { NetworkQuota } from './network-quota.js'
import { QuotaService } from './quota.service.js'
import { RedisNetworkQuota } from './redis-network-quota.js'

/** `GET /me`, the daily job quota and the per-network limit on anonymous jobs. */
@Module({})
export class UsersModule implements OnApplicationShutdown {
  constructor(@Inject(NetworkQuota) private readonly networks: NetworkQuota) {}

  /** Keeps the network counters in the Redis of `REDIS_URL`, under `QUEUE_PREFIX`. */
  static register(config: QueueConfig): DynamicModule {
    return {
      module: UsersModule,
      // Global, so the jobs module shares this instance and its single Redis connection.
      global: true,
      controllers: [MeController],
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

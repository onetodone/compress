import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'

import type { QueueConfig } from '../config/config.js'
import { CallTimer } from '../logging/call-timer.js'
import { BullTaskQueue } from './bull-task-queue.js'
import { createRedisConnection } from './redis.js'
import { TaskQueue } from './task-queue.js'

/** Provides the {@link TaskQueue} on Redis globally and closes it on shutdown. */
@Module({})
export class TasksModule implements OnApplicationShutdown {
  constructor(@Inject(TaskQueue) private readonly queue: TaskQueue) {}

  /** Connects the queue to `REDIS_URL`. */
  static register(config: QueueConfig): DynamicModule {
    return {
      module: TasksModule,
      global: true,
      providers: [
        {
          provide: TaskQueue,
          useFactory: (timer: CallTimer) =>
            new BullTaskQueue(createRedisConnection(config.REDIS_URL, 'producer'), config, timer),
          inject: [CallTimer],
        },
      ],
      exports: [TaskQueue],
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Tests replace the queue with a fake that has nothing to close.
    if (this.queue instanceof BullTaskQueue) await this.queue.close()
  }
}

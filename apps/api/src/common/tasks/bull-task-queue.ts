import { Logger } from '@nestjs/common'
import { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

import type { QueueConfig } from '../config/config.js'
import type { CallTimer } from '../logging/call-timer.js'
import { COMPRESS_TASK, COMPRESSION_QUEUE, type CompressTask, compressTaskId, TaskQueue } from './task-queue.js'

/** Failed tasks stay in Redis this long for inspection, then BullMQ removes them. */
const FAILED_TASK_RETENTION_SECONDS = 7 * 24 * 60 * 60

/** {@link TaskQueue} on a BullMQ queue in Redis. */
export class BullTaskQueue extends TaskQueue {
  private readonly queue: Queue<CompressTask>

  /**
   * @param connection a producer connection (see `createRedisConnection`), closed by {@link close}
   */
  constructor(
    private readonly connection: Redis,
    config: QueueConfig,
    private readonly timer: CallTimer,
  ) {
    super()
    this.queue = new Queue<CompressTask>(COMPRESSION_QUEUE, {
      connection,
      prefix: config.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: config.QUEUE_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: config.QUEUE_BACKOFF_MS },
        // A finished task is removed at once, so its id can be enqueued again; the worker skips
        // jobs that are already done. Production Redis uses noeviction, so nothing may pile up.
        removeOnComplete: true,
        removeOnFail: { age: FAILED_TASK_RETENTION_SECONDS },
      },
    })
    const logger = new Logger(BullTaskQueue.name)
    this.queue.on('error', (error) => logger.warn({ err: error }, 'Queue error'))
  }

  async enqueueCompression(jobId: string): Promise<void> {
    await this.timer.measure('redis', 'queue.add', () =>
      this.queue.add(COMPRESS_TASK, { jobId }, { jobId: compressTaskId(jobId) }),
    )
  }

  /** Closes the queue and its Redis connection. */
  async close(): Promise<void> {
    await this.queue.close()
    this.connection.disconnect()
  }
}

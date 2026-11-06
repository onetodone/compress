import { Logger } from '@nestjs/common'
import { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

import type { QueueConfig } from '../config/config.js'
import type { CallTimer } from '../logging/call-timer.js'
import {
  COMPRESS_TASK,
  COMPRESSION_QUEUE,
  type CompressTask,
  compressTaskId,
  NOTIFICATION_QUEUE,
  NOTIFY_TASK,
  type NotifyTask,
  notifyTaskId,
  TaskQueue,
} from './task-queue.js'

/** Failed tasks stay in Redis this long for inspection, then BullMQ removes them. */
const FAILED_TASK_RETENTION_SECONDS = 7 * 24 * 60 * 60

/** Task states after which BullMQ never runs the task again; `unknown` means there is no such task. */
const SETTLED_TASK_STATES = new Set<string>(['completed', 'failed', 'unknown'])

/** {@link TaskQueue} on BullMQ queues in Redis. */
export class BullTaskQueue extends TaskQueue {
  private readonly queue: Queue<CompressTask>
  private readonly notifications: Queue<NotifyTask>

  /**
   * @param connection a producer connection (see `createRedisConnection`), closed by {@link close}
   */
  constructor(
    private readonly connection: Redis,
    config: QueueConfig,
    private readonly timer: CallTimer,
  ) {
    super()
    const options = {
      connection,
      prefix: config.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: config.QUEUE_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: config.QUEUE_BACKOFF_MS },
        // A finished task is removed at once, so its id can be enqueued again; consumers skip jobs
        // they have already handled. Production Redis uses noeviction, so nothing may pile up.
        removeOnComplete: true,
        removeOnFail: { age: FAILED_TASK_RETENTION_SECONDS },
      },
    }
    this.queue = new Queue<CompressTask>(COMPRESSION_QUEUE, options)
    this.notifications = new Queue<NotifyTask>(NOTIFICATION_QUEUE, options)
    const logger = new Logger(BullTaskQueue.name)
    for (const queue of [this.queue, this.notifications]) {
      queue.on('error', (error) => logger.warn({ err: error, queue: queue.name }, 'Queue error'))
    }
  }

  async enqueueCompression(jobId: string): Promise<void> {
    await this.timer.measure('redis', 'queue.add', () =>
      this.queue.add(COMPRESS_TASK, { jobId }, { jobId: compressTaskId(jobId) }),
    )
  }

  async hasPendingCompression(jobId: string): Promise<boolean> {
    const state = await this.timer.measure('redis', 'queue.getJobState', () =>
      this.queue.getJobState(compressTaskId(jobId)),
    )
    return !SETTLED_TASK_STATES.has(state)
  }

  async enqueueNotification(jobId: string): Promise<void> {
    await this.timer.measure('redis', 'notifications.add', () =>
      this.notifications.add(NOTIFY_TASK, { jobId }, { jobId: notifyTaskId(jobId) }),
    )
  }

  /** Closes the queues and their Redis connection. */
  async close(): Promise<void> {
    await Promise.all([this.queue.close(), this.notifications.close()])
    this.connection.disconnect()
  }
}

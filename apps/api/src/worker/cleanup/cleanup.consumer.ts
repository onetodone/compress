import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'

import type { WorkerConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { createRedisConnection } from '../../common/tasks/redis.js'
import { type CleanupResult, CleanupService } from './cleanup.service.js'
import { CLEANUP_PATTERN } from './stale-jobs.js'

/** Name of the BullMQ queue that carries maintenance tasks. */
export const MAINTENANCE_QUEUE = 'maintenance'

/** Name of the stale job cleanup task within {@link MAINTENANCE_QUEUE}. */
export const CLEANUP_TASK = 'cleanup-stale-jobs'

/**
 * Id of the job scheduler that creates cleanup tasks. Keep it stable: a scheduler under an old id
 * would stay in Redis and keep creating tasks.
 */
export const CLEANUP_SCHEDULER_ID = 'stale-job-cleanup'

/** Failed cleanup tasks kept for inspection; one per hour, so about a day of them. */
const FAILED_CLEANUP_TASKS_KEPT = 24

/**
 * Schedules the stale job cleanup and runs it. Every worker process registers the same scheduler,
 * which BullMQ stores once in Redis, so each run is delivered to one process only.
 */
@Injectable()
export class CleanupConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CleanupConsumer.name)
  private connection: Redis | null = null
  private queue: Queue | null = null
  private worker: Worker | null = null
  private scheduled: Promise<void> = Promise.resolve()

  constructor(
    private readonly cleanup: CleanupService,
    @Inject(CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    const { REDIS_URL, QUEUE_PREFIX } = this.config
    this.connection = createRedisConnection(REDIS_URL, 'consumer')
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: this.connection, prefix: QUEUE_PREFIX })
    this.queue.on('error', (error) => this.logger.warn({ err: error }, 'Maintenance queue error'))
    // Not awaited: while Redis is down the call waits for it, and the worker must start regardless.
    this.scheduled = this.schedule(this.queue).catch((error: unknown) =>
      this.logger.error({ err: error }, 'Could not schedule the stale job cleanup'),
    )

    this.worker = new Worker(MAINTENANCE_QUEUE, () => this.handle(), {
      connection: createRedisConnection(REDIS_URL, 'consumer'),
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    })
    this.worker.on('error', (error) => this.logger.warn({ err: error }, 'Maintenance worker error'))
  }

  /** Resolves once the scheduler is stored in Redis. */
  whenScheduled(): Promise<void> {
    return this.scheduled
  }

  // Upserting an existing scheduler only updates it, so restarts and deploys keep a single one.
  private async schedule(queue: Queue): Promise<void> {
    await queue.upsertJobScheduler(
      CLEANUP_SCHEDULER_ID,
      { pattern: CLEANUP_PATTERN, tz: 'UTC' },
      {
        name: CLEANUP_TASK,
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { count: FAILED_CLEANUP_TASKS_KEPT } },
      },
    )
    this.logger.log({ pattern: CLEANUP_PATTERN }, 'Stale job cleanup scheduled')
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close()
    await this.queue?.close()
    // Rejects a scheduling call still waiting for Redis, which is then only logged.
    this.connection?.disconnect()
    await this.scheduled
    this.worker = null
    this.queue = null
    this.connection = null
  }

  /** Runs one cleanup and logs what it did. A failed run is not retried: the next one covers it. */
  async handle(): Promise<CleanupResult> {
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    try {
      const result = await this.cleanup.run()
      this.logger.log({ ...result, outcome: 'done', durationMs: elapsed() }, 'Stale job cleanup finished')
      return result
    } catch (error) {
      this.logger.error({ outcome: 'failed', durationMs: elapsed(), err: error }, 'Stale job cleanup failed')
      throw error
    }
  }
}

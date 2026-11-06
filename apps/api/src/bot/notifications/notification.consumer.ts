import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { type Job, UnrecoverableError, Worker } from 'bullmq'

import type { BotConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { createRedisConnection } from '../../common/tasks/redis.js'
import { NOTIFICATION_QUEUE, notifyTaskSchema } from '../../common/tasks/task-queue.js'
import { type NotificationOutcome, NotificationService } from './notification.service.js'

/** Answers sent in parallel; Telegram allows about 30 messages per second per bot. */
const CONCURRENCY = 4

/**
 * Consumes the notification queue while the bot runs. Tasks wait in Redis while the bot is down,
 * so a result finished during a restart is still delivered.
 */
@Injectable()
export class NotificationConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationConsumer.name)
  private worker: Worker | null = null

  constructor(
    private readonly notifications: NotificationService,
    @Inject(CONFIG) private readonly config: BotConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker(
      NOTIFICATION_QUEUE,
      (job: Job) => this.handle(job.data, job.attemptsStarted, job.opts.attempts ?? 1),
      {
        connection: createRedisConnection(this.config.REDIS_URL, 'consumer'),
        prefix: this.config.QUEUE_PREFIX,
        concurrency: CONCURRENCY,
      },
    )
    this.worker.on('error', (error) => this.logger.warn({ err: error }, 'Queue worker error'))
    this.logger.log({ concurrency: CONCURRENCY }, 'Consuming notification tasks')
  }

  // Runs before other providers shut down, so running tasks can still reach Firestore and Telegram.
  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return
    await this.worker.close()
    this.worker = null
  }

  /**
   * Processes one attempt of a notification task and logs its outcome.
   *
   * @throws Error when the task should be retried
   * @throws UnrecoverableError when the task data is invalid
   */
  async handle(data: unknown, attempt: number, maxAttempts: number): Promise<NotificationOutcome> {
    const parsed = notifyTaskSchema.safeParse(data)
    if (!parsed.success) {
      this.logger.error({ attempt }, 'Notification task without a valid job id')
      throw new UnrecoverableError('Invalid task data')
    }
    const { jobId } = parsed.data
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)

    try {
      const outcome = await this.notifications.deliver(jobId)
      this.logger.log({ jobId, attempt, outcome, durationMs: elapsed() }, `Notification task ${outcome}`)
      return outcome
    } catch (error) {
      const last = attempt >= maxAttempts
      const entry = { jobId, attempt, outcome: last ? 'failed' : 'retry', durationMs: elapsed(), err: error }
      if (last) this.logger.error(entry, 'Notification task failed on the last attempt')
      else this.logger.warn(entry, 'Notification task will be retried')
      throw error
    }
  }
}

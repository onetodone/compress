import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { type Job, UnrecoverableError, Worker } from 'bullmq'

import type { WorkerConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { createRedisConnection } from '../../common/tasks/redis.js'
import { COMPRESSION_QUEUE, compressTaskSchema } from '../../common/tasks/task-queue.js'
import { CompressionService, type TaskOutcome } from './compression.service.js'

/** Attempt of a compression task, as BullMQ reports it. */
export interface TaskAttempt {
  data: unknown
  /** 1-based number of this attempt, counting attempts that crashed or stalled. */
  attempt: number
  maxAttempts: number
}

/** Consumes the compression queue while the application runs. */
@Injectable()
export class CompressionConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CompressionConsumer.name)
  private worker: Worker | null = null

  constructor(
    private readonly compression: CompressionService,
    @Inject(CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    const { QUEUE_PREFIX, QUEUE_CONCURRENCY, QUEUE_MAX_ATTEMPTS } = this.config
    this.worker = new Worker(COMPRESSION_QUEUE, (job: Job) => this.handle(fromJob(job)), {
      connection: createRedisConnection(this.config.REDIS_URL, 'consumer'),
      prefix: QUEUE_PREFIX,
      concurrency: QUEUE_CONCURRENCY,
      // A task whose worker died is picked up again. BullMQ would fail it after this many stalls
      // without telling the job; the attempt counter in `handle` fails the job first.
      maxStalledCount: QUEUE_MAX_ATTEMPTS,
    })
    this.worker.on('error', (error) => this.logger.warn({ err: error }, 'Queue worker error'))
    this.logger.log({ concurrency: QUEUE_CONCURRENCY }, 'Consuming compression tasks')
  }

  // Runs before other providers shut down, so the running tasks can still reach Firestore and R2.
  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return
    this.logger.log('Waiting for running compression tasks')
    await this.worker.close()
    this.worker = null
  }

  /**
   * Processes one attempt of a compression task and logs its outcome.
   *
   * @throws Error when the task should be retried
   * @throws UnrecoverableError when the task data is invalid, so it is never retried
   */
  async handle({ data, attempt, maxAttempts }: TaskAttempt): Promise<TaskOutcome> {
    const parsed = compressTaskSchema.safeParse(data)
    if (!parsed.success) {
      this.logger.error({ attempt }, 'Compression task without a valid job id')
      throw new UnrecoverableError('Invalid task data')
    }
    const { jobId } = parsed.data
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)

    try {
      const outcome = await this.compression.process(jobId, attempt, maxAttempts)
      this.logger.log({ jobId, attempt, outcome, durationMs: elapsed() }, `Compression task ${outcome}`)
      return outcome
    } catch (error) {
      this.logger.warn(
        { jobId, attempt, outcome: 'retry', durationMs: elapsed(), err: error },
        'Compression task will be retried',
      )
      throw error
    }
  }
}

function fromJob(job: Job): TaskAttempt {
  return { data: job.data, attempt: job.attemptsStarted, maxAttempts: job.opts.attempts ?? 1 }
}

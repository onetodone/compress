import { jobIdSchema } from '@onetodone/image-compressor-shared'
import { z } from 'zod'

/** Name of the BullMQ queue that carries compression tasks. */
export const COMPRESSION_QUEUE = 'compression'

/** Name of a compression task within {@link COMPRESSION_QUEUE}. */
export const COMPRESS_TASK = 'compress'

/** Validates the data of a compression task. */
export const compressTaskSchema = z.object({ jobId: jobIdSchema })

/** Data of a compression task. */
export type CompressTask = z.infer<typeof compressTaskSchema>

/**
 * BullMQ id of the compression task of a job. BullMQ ignores an add with an id it still holds, so
 * the id makes enqueueing idempotent; the prefix keeps it from being all digits, which BullMQ rejects.
 */
export function compressTaskId(jobId: string): string {
  return `compress-${jobId}`
}

/** Hands jobs to the worker. Injected by this class, so tests can replace the queue. */
export abstract class TaskQueue {
  /**
   * Schedules compression of a queued job. Calling it again for the same job is safe: a task that
   * is still pending is not added twice, and the worker ignores jobs that are already processed.
   */
  abstract enqueueCompression(jobId: string): Promise<void>
}

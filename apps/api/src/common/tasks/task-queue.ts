import { jobIdSchema } from '@onetodone/compress-shared'
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

/** Name of the BullMQ queue that carries chat notifications about finished jobs, consumed by the bot. */
export const NOTIFICATION_QUEUE = 'notifications'

/** Name of a notification task within {@link NOTIFICATION_QUEUE}. */
export const NOTIFY_TASK = 'notify'

/** Validates the data of a notification task. */
export const notifyTaskSchema = z.object({ jobId: jobIdSchema })

/** Data of a notification task. */
export type NotifyTask = z.infer<typeof notifyTaskSchema>

/** BullMQ id of the notification task of a job; see {@link compressTaskId}. */
export function notifyTaskId(jobId: string): string {
  return `notify-${jobId}`
}

/** Hands jobs to the worker. Injected by this class, so tests can replace the queue. */
export abstract class TaskQueue {
  /**
   * Schedules compression of a queued job. Calling it again for the same job is safe: a task that
   * is still pending is not added twice, and the worker ignores jobs that are already processed.
   */
  abstract enqueueCompression(jobId: string): Promise<void>

  /**
   * Whether the compression task of a job is still waiting, delayed for a retry or running. A task
   * that is missing, completed or failed will not touch the job again.
   */
  abstract hasPendingCompression(jobId: string): Promise<boolean>

  /**
   * Asks the bot to answer the chat message a finished job was created from. A task that is still
   * pending is not added twice; the bot also skips jobs it has already answered.
   */
  abstract enqueueNotification(jobId: string): Promise<void>
}

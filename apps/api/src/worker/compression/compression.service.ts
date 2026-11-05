import { Injectable, Logger } from '@nestjs/common'
import { type JobStatus, TERMINAL_JOB_STATUSES, utcDayKey } from '@onetodone/image-compressor-shared'
import { type DocumentSnapshot, FieldValue, Firestore, Timestamp } from 'firebase-admin/firestore'

import { ImageCdn } from '../../common/cloudinary/image-cdn.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import { readStoredUsage, refundQuota } from '../../common/quota/quota.js'
import { resultKey } from '../../common/r2/object-keys.js'
import { ObjectStorage } from '../../common/r2/object-storage.js'
import { compressImage } from './compress-image.js'
import { PermanentJobError } from './permanent-job-error.js'

const JOBS = 'jobs'
const USERS = 'users'

const RETRIES_EXHAUSTED = 'The image could not be processed. Please try again later.'

/**
 * Result of one task attempt: the job was finished (`done`, `failed`), or there was nothing to do
 * because the job does not exist or is already finished (`skipped`).
 */
export type TaskOutcome = 'done' | 'failed' | 'skipped'

interface ClaimedJob {
  ownerId: string
  inputKey: string
}

/** Compresses queued jobs. Safe to run more than once for the same job, as the queue may deliver a task twice. */
@Injectable()
export class CompressionService {
  private readonly logger = new Logger(CompressionService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly storage: ObjectStorage,
    private readonly cdn: ImageCdn,
    private readonly timer: CallTimer,
  ) {}

  /**
   * Processes one attempt of a compression task.
   *
   * @param attempt 1-based attempt; the last one fails the job instead of asking for a retry
   * @param maxAttempts attempts the task gets in total. An attempt beyond it follows one that never
   *   finished (the worker crashed or stalled), so the job is failed without trying again.
   * @throws Error on a transient failure before the last attempt, so the task is retried
   */
  async process(jobId: string, attempt: number, maxAttempts: number): Promise<TaskOutcome> {
    if (attempt > maxAttempts) {
      this.logger.error({ jobId, attempt }, 'Compression did not finish within the attempt limit')
      return this.fail(jobId, RETRIES_EXHAUSTED)
    }

    const job = await this.claim(jobId)
    if (!job) return 'skipped'

    try {
      return await this.compress(jobId, job)
    } catch (error) {
      if (error instanceof PermanentJobError) return this.fail(jobId, error.message)
      if (attempt < maxAttempts) throw error
      this.logger.error({ jobId, attempt, err: error }, 'Compression failed on the last attempt')
      return this.fail(jobId, RETRIES_EXHAUSTED)
    }
  }

  /**
   * Moves a queued job to `processing`. A job already in `processing` is taken over, because the
   * attempt that set it may have crashed. Returns `null` when there is nothing to process.
   */
  private claim(jobId: string): Promise<ClaimedJob | null> {
    const ref = this.ref(jobId)
    return this.timer.measure('firestore', 'jobs.claim', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        const status = snapshot.get('status') as JobStatus | undefined
        if (status !== 'queued' && status !== 'processing') return null
        tx.update(ref, {
          status: 'processing',
          attempts: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        })
        return { ownerId: snapshot.get('ownerId') as string, inputKey: snapshot.get('inputKey') as string }
      }),
    )
  }

  private async compress(jobId: string, job: ClaimedJob): Promise<TaskOutcome> {
    const original = await this.storage.get(job.inputKey)
    if (!original) throw new PermanentJobError('The uploaded file is no longer available')

    const image = await compressImage(original)
    const outputKey = resultKey(job.ownerId, jobId, image.type)
    await this.storage.put(outputKey, image.data, image.type)
    const previewUrl = await this.cdn.upload(jobId, image.data)

    const ref = this.ref(jobId)
    const outcome = await this.timer.measure('firestore', 'jobs.done', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        if (!snapshot.exists) return 'deleted'
        // A concurrent delivery may have finished the job meanwhile; its result stands.
        if (snapshot.get('status') !== 'processing') return 'skipped'
        const now = FieldValue.serverTimestamp()
        tx.update(ref, {
          status: 'done',
          inputType: image.type,
          inputBytes: original.length,
          outputKey,
          outputBytes: image.data.length,
          width: image.width,
          height: image.height,
          previewUrl,
          error: null,
          updatedAt: now,
          finishedAt: now,
        })
        return 'done'
      }),
    )
    if (outcome !== 'deleted') return outcome

    // The owner deleted the job while it was processing, after its files had been removed.
    await Promise.all([this.storage.delete(outputKey), this.cdn.delete(jobId)])
    return 'skipped'
  }

  /**
   * Marks the job `failed` and gives its quota unit back. `quotaRefunded` and the terminal status
   * guard the refund, so repeated deliveries never refund twice.
   */
  private fail(jobId: string, message: string): Promise<TaskOutcome> {
    const ref = this.ref(jobId)
    return this.timer.measure('firestore', 'jobs.fail', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        if (!snapshot.exists || TERMINAL_JOB_STATUSES.includes(snapshot.get('status') as JobStatus)) return 'skipped'

        let quotaRefunded = snapshot.get('quotaRefunded') === true
        const dayKey = quotaDayKey(snapshot)
        if (!quotaRefunded && dayKey) {
          const userRef = this.firestore.collection(USERS).doc(snapshot.get('ownerId') as string)
          const refunded = refundQuota(readStoredUsage((await tx.get(userRef)).data()), dayKey)
          if (refunded) {
            tx.update(userRef, { jobsToday: refunded.jobsToday })
            quotaRefunded = true
          }
        }

        const now = FieldValue.serverTimestamp()
        tx.update(ref, { status: 'failed', error: message, quotaRefunded, updatedAt: now, finishedAt: now })
        return 'failed'
      }),
    )
  }

  private ref(jobId: string) {
    return this.firestore.collection(JOBS).doc(jobId)
  }
}

/**
 * UTC day the job's quota unit was counted on. Jobs submitted before `quotaDayKey` was stored fall
 * back to their creation day.
 */
function quotaDayKey(job: DocumentSnapshot): string | null {
  const dayKey: unknown = job.get('quotaDayKey')
  if (typeof dayKey === 'string') return dayKey
  const createdAt: unknown = job.get('createdAt')
  return createdAt instanceof Timestamp ? utcDayKey(createdAt.toDate()) : null
}

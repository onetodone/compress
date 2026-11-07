import { Injectable, Logger } from '@nestjs/common'
import { type CompressionPreset, isImageType, type JobStatus, readJobSettings } from '@onetodone/compress-shared'
import { type DocumentData, FieldValue, Firestore } from 'firebase-admin/firestore'

import { ImageCdn } from '../../common/cloudinary/image-cdn.js'
import { awaitsChatAnswer, failJob, JOBS } from '../../common/jobs/job-records.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import { resultKey } from '../../common/r2/object-keys.js'
import { ObjectStorage } from '../../common/r2/object-storage.js'
import { TaskQueue } from '../../common/tasks/task-queue.js'
import { compressImage } from './compress-image.js'
import { isPdf, PdfCompressor } from './compress-pdf.js'
import type { CompressedFile } from './compressed-file.js'
import { PermanentJobError } from './permanent-job-error.js'

/** Error of a job whose compression did not succeed within the attempt limit. */
export const RETRIES_EXHAUSTED = 'The file could not be processed. Please try again later.'

/**
 * Result of one task attempt: the job was finished (`done`, `failed`), or there was nothing to do
 * because the job does not exist or is already finished (`skipped`).
 */
export type TaskOutcome = 'done' | 'failed' | 'skipped'

interface ClaimedJob {
  ownerId: string
  inputKey: string
  preset: CompressionPreset
  /** The job document as claimed. */
  data: DocumentData
}

/** A job taken for processing, or the data of one there is nothing to do for (`undefined` if missing). */
type Claim = { job: ClaimedJob } | { skipped: DocumentData | undefined }

/** Compresses queued jobs. Safe to run more than once for the same job, as the queue may deliver a task twice. */
@Injectable()
export class CompressionService {
  private readonly logger = new Logger(CompressionService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly storage: ObjectStorage,
    private readonly cdn: ImageCdn,
    private readonly tasks: TaskQueue,
    private readonly pdf: PdfCompressor,
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

    const claim = await this.claim(jobId)
    if ('skipped' in claim) {
      // An earlier attempt may have finished the job and crashed before asking for the chat answer.
      await this.notifyChat(jobId, claim.skipped)
      return 'skipped'
    }

    try {
      return await this.compress(jobId, claim.job)
    } catch (error) {
      if (error instanceof PermanentJobError) {
        if (error.detail) this.logger.warn({ jobId, detail: error.detail }, `Compression refused: ${error.message}`)
        return this.fail(jobId, error.message)
      }
      if (attempt < maxAttempts) throw error
      this.logger.error({ jobId, attempt, err: error }, 'Compression failed on the last attempt')
      return this.fail(jobId, RETRIES_EXHAUSTED)
    }
  }

  /**
   * Moves a queued job to `processing`. A job already in `processing` is taken over, because the
   * attempt that set it may have crashed.
   */
  private claim(jobId: string): Promise<Claim> {
    const ref = this.ref(jobId)
    return this.timer.measure('firestore', 'jobs.claim', () =>
      this.firestore.runTransaction(async (tx): Promise<Claim> => {
        const snapshot = await tx.get(ref)
        const status = snapshot.get('status') as JobStatus | undefined
        if (status !== 'queued' && status !== 'processing') return { skipped: snapshot.data() }
        tx.update(ref, {
          status: 'processing',
          attempts: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        })
        return {
          job: {
            ownerId: snapshot.get('ownerId') as string,
            inputKey: snapshot.get('inputKey') as string,
            preset: readJobSettings(snapshot.get('settings')).preset,
            data: snapshot.data()!,
          },
        }
      }),
    )
  }

  private async compress(jobId: string, job: ClaimedJob): Promise<TaskOutcome> {
    const original = await this.storage.get(job.inputKey)
    if (!original) throw new PermanentJobError('The uploaded file is no longer available')

    const result = await this.compressFile(original, job.preset)
    const outputKey = resultKey(job.ownerId, jobId, result.type)
    await this.storage.put(outputKey, result.data, result.type)
    // Previews are images; the web app shows an icon for documents.
    const previewUrl = isImageType(result.type) ? await this.cdn.upload(jobId, result.data) : null

    const ref = this.ref(jobId)
    const outcome = await this.timer.measure('firestore', 'jobs.done', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        if (!snapshot.exists) return 'deleted'
        // A concurrent delivery may have finished the job meanwhile; its result stands.
        if (snapshot.get('status') !== 'processing') return 'skipped'
        const now = FieldValue.serverTimestamp()
        tx.update(ref, {
          status: 'done' satisfies JobStatus,
          inputType: result.type,
          outputType: result.type,
          inputBytes: original.length,
          outputKey,
          outputBytes: result.data.length,
          width: result.width,
          height: result.height,
          previewUrl,
          error: null,
          updatedAt: now,
          finishedAt: now,
        })
        return 'done'
      }),
    )
    if (outcome === 'done') await this.notifyChat(jobId, { ...job.data, status: 'done' })
    if (outcome !== 'deleted') return outcome

    // The owner deleted the job while it was processing, after its files had been removed.
    await Promise.all([this.storage.delete(outputKey), this.cdn.delete(jobId)])
    return 'skipped'
  }

  /** Compresses a file into its own format, which is detected from the content. */
  private compressFile(original: Buffer, preset: CompressionPreset): Promise<CompressedFile> {
    return isPdf(original) ? this.pdf.compress(original, preset) : compressImage(original, preset)
  }

  /** Marks the job `failed` and gives its quota unit back; repeated deliveries never refund twice. */
  private async fail(jobId: string, message: string): Promise<TaskOutcome> {
    const failed = await this.timer.measure('firestore', 'jobs.fail', () => failJob(this.firestore, jobId, message))
    if (!failed) return 'skipped'
    await this.notifyChat(jobId, failed)
    return 'failed'
  }

  /** Asks the bot to answer the chat message a finished job came from, if there is one to answer. */
  private async notifyChat(jobId: string, job: DocumentData | undefined): Promise<void> {
    if (awaitsChatAnswer(job)) await this.tasks.enqueueNotification(jobId)
  }

  private ref(jobId: string) {
    return this.firestore.collection(JOBS).doc(jobId)
  }
}

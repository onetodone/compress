import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  type CreateJobRequest,
  type CreateJobResponse,
  DOWNLOAD_URL_TTL_SECONDS,
  formatBytes,
  downloadFileName,
  type DownloadJobQuery,
  type DownloadJobResponse,
  imageTypeSchema,
  type JobStatus,
  type JobSummary,
  jobIdSchema,
  type ListJobsQuery,
  type ListJobsResponse,
  type SubmitJobResponse,
  toJobSummary,
  UPLOAD_URL_TTL_SECONDS,
} from '@onetodone/image-compressor-shared'
import { type DocumentReference, FieldPath, FieldValue, Firestore, type Timestamp } from 'firebase-admin/firestore'

import { ImageCdn } from '../../common/cloudinary/image-cdn.js'
import { JOBS, removeJobFiles } from '../../common/jobs/job-records.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import { originalKey } from '../../common/r2/object-keys.js'
import { ObjectStorage } from '../../common/r2/object-storage.js'
import { TaskQueue } from '../../common/tasks/task-queue.js'
import type { AuthUser } from '../../common/auth/auth-user.js'
import { QuotaService } from '../users/quota.service.js'
import { contentDisposition } from './content-disposition.js'
import { decodeJobCursor, encodeJobCursor } from './job-cursor.js'

/** Creates, submits, lists, downloads and deletes the jobs of the current user. */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly storage: ObjectStorage,
    private readonly cdn: ImageCdn,
    private readonly tasks: TaskQueue,
    private readonly quota: QuotaService,
    private readonly timer: CallTimer,
  ) {}

  /** Returns one page of the user's jobs, newest first. */
  async list(user: AuthUser, { limit, cursor }: ListJobsQuery): Promise<ListJobsResponse> {
    let query = this.firestore
      .collection(JOBS)
      .where('ownerId', '==', user.uid)
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      // One extra document tells whether another page exists.
      .limit(limit + 1)
    if (cursor !== undefined) {
      const position = decodeJobCursor(cursor)
      if (!position) throw new BadRequestException('Invalid cursor')
      query = query.startAfter(position.createdAt, position.id)
    }

    const snapshot = await this.timer.measure('firestore', 'jobs.list', () => query.get())
    const page = snapshot.docs.slice(0, limit)
    const last = page.at(-1)
    const nextCursor =
      snapshot.docs.length > limit && last
        ? encodeJobCursor({ createdAt: last.get('createdAt') as Timestamp, id: last.id })
        : null
    const jobs = page.flatMap((doc) => {
      const summary = toJobSummary(doc.id, doc.data())
      if (!summary) this.logger.warn({ jobId: doc.id }, 'Left out a job document that cannot be read')
      return summary ? [summary] : ([] as JobSummary[])
    })
    return { jobs, nextCursor }
  }

  /** @param ip client address, for the per-network limit on anonymous jobs */
  async create(user: AuthUser, ip: string | undefined, request: CreateJobRequest): Promise<CreateJobResponse> {
    const { maxInputBytes } = this.quota.entitlements(user)
    if (request.size > maxInputBytes) throw new BadRequestException(tooLarge(maxInputBytes))
    // Quota is consumed on submit; checking it here only saves an upload that could never be submitted.
    await this.quota.assertAvailable(user, ip)

    const ref = this.firestore.collection(JOBS).doc()
    const inputKey = originalKey(user.uid, ref.id)
    const upload = await this.storage.presignUpload(
      inputKey,
      { contentType: request.contentType, contentLength: request.size },
      UPLOAD_URL_TTL_SECONDS,
    )

    const now = FieldValue.serverTimestamp()
    await this.timer.measure('firestore', 'jobs.create', () =>
      ref.create({
        ownerId: user.uid,
        status: 'awaiting_upload' satisfies JobStatus,
        originalName: request.originalName,
        // The declared type; the worker replaces it with the type detected from the file.
        inputType: request.contentType,
        outputType: null,
        settings: request.settings,
        inputKey,
        inputBytes: null,
        outputKey: null,
        outputBytes: null,
        width: null,
        height: null,
        previewUrl: null,
        error: null,
        attempts: 0,
        quotaDayKey: null,
        quotaRefunded: false,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      }),
    )
    return { jobId: ref.id, uploadUrl: upload.url, uploadExpiresAt: upload.expiresAt.toISOString() }
  }

  /**
   * Confirms the upload, consumes quota and queues the job. Repeating the call is safe: a job that
   * is already queued is enqueued again without consuming more quota, which also recovers a job
   * whose first enqueue failed after the transaction committed.
   *
   * @param ip client address, for the per-network limit on anonymous jobs
   */
  async submit(user: AuthUser, ip: string | undefined, jobId: string): Promise<SubmitJobResponse> {
    const ref = this.ref(jobId)
    const snapshot = await this.timer.measure('firestore', 'jobs.get', () => ref.get())
    if (!snapshot.exists || snapshot.get('ownerId') !== user.uid) throw new NotFoundException('Job not found')

    let status = snapshot.get('status') as JobStatus
    if (status === 'awaiting_upload') {
      const inputBytes = await this.verifyUpload(
        snapshot.get('inputKey') as string,
        snapshot.get('inputType') as string,
        this.quota.entitlements(user).maxInputBytes,
      )
      const reservation = await this.quota.reserveNetwork(user, ip)
      let consumed = false
      try {
        ;({ status, consumed } = await this.timer.measure('firestore', 'jobs.submit', () =>
          this.firestore.runTransaction(async (tx) => {
            const current = (await tx.get(ref)).get('status') as JobStatus
            if (current !== 'awaiting_upload') return { status: current, consumed: false }
            const { dayKey } = await this.quota.consume(tx, user)
            tx.update(ref, {
              status: 'queued',
              inputBytes,
              quotaDayKey: dayKey,
              updatedAt: FieldValue.serverTimestamp(),
            })
            return { status: 'queued' as const, consumed: true }
          }),
        ))
      } finally {
        // A submit that consumed nothing (refused, failed or already done by a concurrent call)
        // gives the network its job back.
        if (reservation && !consumed) await this.quota.releaseNetwork(reservation)
      }
    }

    if (status === 'queued') await this.tasks.enqueueCompression(jobId)
    return { jobId, status }
  }

  /** Returns a short-lived URL of the compressed result, to save or to display in the browser. */
  async download(user: AuthUser, jobId: string, { disposition }: DownloadJobQuery): Promise<DownloadJobResponse> {
    const snapshot = await this.timer.measure('firestore', 'jobs.get', () => this.ref(jobId).get())
    // Old jobs are removed with their files, so a tab opened earlier may still ask for one.
    if (!snapshot.exists || snapshot.get('ownerId') !== user.uid) {
      throw new NotFoundException('The image is no longer available')
    }
    const outputKey = snapshot.get('outputKey') as string | null | undefined
    if (snapshot.get('status') !== 'done' || !outputKey) throw new ConflictException('The job is not finished')

    // A document without `outputType` has its result in the input type.
    const type = imageTypeSchema.parse(snapshot.get('outputType') ?? snapshot.get('inputType'))
    const fileName = downloadFileName(snapshot.get('originalName') as string, type)
    const download = await this.storage.presignDownload(
      outputKey,
      { contentType: type, contentDisposition: contentDisposition(disposition, fileName) },
      DOWNLOAD_URL_TTL_SECONDS,
    )
    return { url: download.url, expiresAt: download.expiresAt.toISOString() }
  }

  /**
   * Deletes the job document, then its files. The document goes first, so a worker still processing
   * the job finds it gone and removes the files it creates itself. A file that cannot be removed is
   * only logged: the job is already gone for the user, and the bucket lifecycle rules expire it.
   */
  async delete(user: AuthUser, jobId: string): Promise<void> {
    const ref = this.ref(jobId)
    const job = await this.timer.measure('firestore', 'jobs.delete', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        if (!snapshot.exists || snapshot.get('ownerId') !== user.uid) return null
        tx.delete(ref)
        return snapshot.data()!
      }),
    )
    if (!job) throw new NotFoundException('Job not found')

    for (const { file, error } of await removeJobFiles(this.storage, this.cdn, jobId, job)) {
      this.logger.error({ jobId, file, err: error }, 'Could not remove a file of a deleted job')
    }
  }

  /** Returns the size of the uploaded original after checking it against the job. */
  private async verifyUpload(key: string, declaredType: string, maxInputBytes: number): Promise<number> {
    const object = await this.storage.head(key)
    if (!object) throw new ConflictException('The file has not been uploaded')
    // The presigned URL binds type and size, so a mismatch means the object did not come from it.
    if (object.size === 0) throw new BadRequestException('The file is empty')
    if (object.size > maxInputBytes) throw new BadRequestException(tooLarge(maxInputBytes))
    if (object.contentType !== declaredType) throw new BadRequestException('The file type does not match the job')
    return object.size
  }

  private ref(jobId: string): DocumentReference {
    if (!jobIdSchema.safeParse(jobId).success) throw new NotFoundException('Job not found')
    return this.firestore.collection(JOBS).doc(jobId)
  }
}

function tooLarge(maxInputBytes: number): string {
  return `The file must be at most ${formatBytes(maxInputBytes)}`
}

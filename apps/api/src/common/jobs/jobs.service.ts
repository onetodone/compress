import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  type CreateJobRequest,
  type CreateJobResponse,
  DOWNLOAD_URL_TTL_SECONDS,
  formatBytes,
  downloadFileName,
  type DownloadJobQuery,
  type DownloadJobResponse,
  fileFormats,
  type FileType,
  fileTypeSchema,
  type JobStatus,
  type JobSummary,
  jobIdSchema,
  type ListJobsQuery,
  type ListJobsResponse,
  type SubmitJobResponse,
  toJobSummary,
  UPLOAD_URL_TTL_SECONDS,
} from '@onetodone/compress-shared'
import {
  type DocumentReference,
  FieldPath,
  FieldValue,
  Firestore,
  type Query,
  type Timestamp,
} from 'firebase-admin/firestore'

import { ImageCdn } from '../cloudinary/image-cdn.js'
import { type ChatTarget, JOBS, type JobSource, removeJobFiles } from './job-records.js'
import { CallTimer } from '../logging/call-timer.js'
import { originalKey } from '../r2/object-keys.js'
import { ObjectStorage } from '../r2/object-storage.js'
import { TaskQueue } from '../tasks/task-queue.js'
import type { AuthUser } from '../auth/auth-user.js'
import { QuotaService } from '../quota/quota.service.js'
import { contentDisposition } from './content-disposition.js'
import { decodeJobCursor, encodeJobCursor } from './job-cursor.js'

/** Where a new job comes from; a job from a chat message names the message to answer. */
export type JobOrigin = { source: 'web' } | { source: 'telegram'; notify: ChatTarget }

/** One page of a user's jobs, counted by position. */
export interface JobPage {
  jobs: JobSummary[]
  /** Jobs the user has in total. */
  total: number
}

/** The compressed result of a finished job. */
export interface JobResult {
  /** R2 key of the result. */
  key: string
  type: FileType
  /** Name to save the result under. */
  fileName: string
}

/**
 * Creates, submits, lists, downloads and deletes the jobs of a user. Shared by the HTTP API and the
 * bot; errors are Nest HTTP exceptions with user-safe messages.
 */
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
    // One extra document tells whether another page exists.
    let query = this.newestFirst(user).limit(limit + 1)
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
    return { jobs: this.summaries(page), nextCursor }
  }

  /**
   * Returns the jobs at a position in the user's list, newest first, and how many jobs there are.
   * Counted by position, so a client can step back and forth; the history is short (jobs expire
   * after a week), so skipping documents stays cheap.
   *
   * @param offset jobs to skip
   * @param limit jobs to return at most
   */
  async page(user: AuthUser, offset: number, limit: number): Promise<JobPage> {
    const query = this.newestFirst(user)
    const [snapshot, count] = await this.timer.measure('firestore', 'jobs.page', () =>
      Promise.all([query.offset(offset).limit(limit).get(), query.count().get()]),
    )
    return { jobs: this.summaries(snapshot.docs), total: count.data().count }
  }

  /**
   * Refuses a file the user may not compress now: of a type the service does not accept, too large,
   * or no jobs left today. Nothing is counted; quota is consumed on submit, so this only saves an
   * upload that could never be submitted.
   *
   * @param ip client address, for the per-network limit on anonymous jobs
   * @param type declared MIME type of the file
   * @param size size of the file in bytes
   * @throws BadRequestException when the type is not accepted or the file is too large
   * @throws HttpException 429 when a daily limit is reached
   */
  async assertCanCreate(user: AuthUser, ip: string | undefined, type: FileType, size: number): Promise<void> {
    const maxBytes = this.maxInputBytes(user, type)
    if (size > maxBytes) throw new BadRequestException(tooLarge(maxBytes))
    await this.quota.assertAvailable(user, ip)
  }

  /**
   * Creates a job for a file the client uploads itself, through the returned presigned URL.
   * @param ip client address, for the per-network limit on anonymous jobs
   */
  async create(user: AuthUser, ip: string | undefined, request: CreateJobRequest): Promise<CreateJobResponse> {
    await this.assertCanCreate(user, ip, request.contentType, request.size)
    const ref = this.firestore.collection(JOBS).doc()
    const upload = await this.storage.presignUpload(
      originalKey(user.uid, ref.id),
      { contentType: request.contentType, contentLength: request.size },
      UPLOAD_URL_TTL_SECONDS,
    )
    await this.createRecord(ref, user, request, { source: 'web' })
    return { jobId: ref.id, uploadUrl: upload.url, uploadExpiresAt: upload.expiresAt.toISOString() }
  }

  /**
   * Creates a job for a file the server already holds, stores the original and submits the job. A
   * job refused before it is queued is deleted again, so nothing is left behind; one that is queued
   * but cannot be enqueued stays, and the stale job cleanup fails it and refunds its quota.
   *
   * @param request name, declared type and size of `data`
   * @param data content of the original file
   * @param origin where the job comes from
   * @throws HttpException with a user-safe message when the job is refused
   */
  async createFromFile(
    user: AuthUser,
    request: CreateJobRequest,
    data: Buffer,
    origin: JobOrigin,
  ): Promise<SubmitJobResponse> {
    await this.assertCanCreate(user, undefined, request.contentType, data.length)
    const ref = this.firestore.collection(JOBS).doc()
    await this.createRecord(ref, user, { ...request, size: data.length }, origin)
    try {
      await this.storage.put(originalKey(user.uid, ref.id), data, request.contentType)
      return await this.submit(user, undefined, ref.id)
    } catch (error) {
      await this.deleteUnsubmitted(ref.id).catch((cleanup: unknown) =>
        this.logger.error({ jobId: ref.id, err: cleanup }, 'Could not delete a job that was not submitted'),
      )
      throw error
    }
  }

  private async createRecord(
    ref: DocumentReference,
    user: AuthUser,
    request: CreateJobRequest,
    origin: JobOrigin,
  ): Promise<void> {
    const now = FieldValue.serverTimestamp()
    await this.timer.measure('firestore', 'jobs.create', () =>
      ref.create({
        ownerId: user.uid,
        source: origin.source satisfies JobSource,
        notify: origin.source === 'telegram' ? origin.notify : null,
        status: 'awaiting_upload' satisfies JobStatus,
        originalName: request.originalName,
        // The declared type; the worker replaces it with the type detected from the file.
        inputType: request.contentType,
        outputType: null,
        settings: request.settings,
        inputKey: originalKey(user.uid, ref.id),
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
      const inputBytes = await this.verifyUpload(user, snapshot.get('inputKey') as string, snapshot.get('inputType'))
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
    const { key, type, fileName } = await this.result(user, jobId)
    const download = await this.storage.presignDownload(
      key,
      { contentType: type, contentDisposition: contentDisposition(disposition, fileName) },
      DOWNLOAD_URL_TTL_SECONDS,
    )
    return { url: download.url, expiresAt: download.expiresAt.toISOString() }
  }

  /**
   * Returns one job of the user.
   * @throws NotFoundException when the job is gone, not the user's or cannot be read
   */
  async get(user: AuthUser, jobId: string): Promise<JobSummary> {
    const snapshot = await this.timer.measure('firestore', 'jobs.get', () => this.ref(jobId).get())
    const summary =
      snapshot.exists && snapshot.get('ownerId') === user.uid ? toJobSummary(snapshot.id, snapshot.data()!) : null
    if (!summary) throw new NotFoundException(NO_LONGER_AVAILABLE)
    return summary
  }

  /**
   * Returns where the compressed result of a finished job is stored and how to name it.
   * @throws NotFoundException when the job is gone or not the user's
   * @throws ConflictException when the job is not finished
   */
  async result(user: AuthUser, jobId: string): Promise<JobResult> {
    const snapshot = await this.timer.measure('firestore', 'jobs.get', () => this.ref(jobId).get())
    // Old jobs are removed with their files, so a client opened earlier may still ask for one.
    if (!snapshot.exists || snapshot.get('ownerId') !== user.uid) {
      throw new NotFoundException(NO_LONGER_AVAILABLE)
    }
    const outputKey = snapshot.get('outputKey') as string | null | undefined
    if (snapshot.get('status') !== 'done' || !outputKey) throw new ConflictException('The job is not finished')

    // A document without `outputType` has its result in the input type.
    const type = fileTypeSchema.parse(snapshot.get('outputType') ?? snapshot.get('inputType'))
    return { key: outputKey, type, fileName: downloadFileName(snapshot.get('originalName') as string, type) }
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

  /** Deletes a job and its original while it is still `awaiting_upload`. */
  private async deleteUnsubmitted(jobId: string): Promise<void> {
    const ref = this.ref(jobId)
    const job = await this.timer.measure('firestore', 'jobs.delete', () =>
      this.firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref)
        if (snapshot.get('status') !== 'awaiting_upload') return null
        tx.delete(ref)
        return snapshot.data()!
      }),
    )
    if (!job) return
    for (const { file, error } of await removeJobFiles(this.storage, this.cdn, jobId, job)) {
      this.logger.error({ jobId, file, err: error }, 'Could not remove a file of a job that was not submitted')
    }
  }

  /**
   * Returns the largest file of a type the user may upload.
   * @throws BadRequestException when the service does not accept the type
   */
  private maxInputBytes(user: AuthUser, type: FileType): number {
    const maxBytes = this.quota.entitlements(user).inputLimits[type]
    if (maxBytes === undefined) throw new BadRequestException(`${fileFormats.info(type).name} files are not supported`)
    return maxBytes
  }

  /** Returns the size of the uploaded original after checking it against the job. */
  private async verifyUpload(user: AuthUser, key: string, declaredType: unknown): Promise<number> {
    const type = fileTypeSchema.parse(declaredType)
    // PDF compression may have been turned off since the job was created.
    const maxBytes = this.maxInputBytes(user, type)
    const object = await this.storage.head(key)
    if (!object) throw new ConflictException('The file has not been uploaded')
    // The presigned URL binds type and size, so a mismatch means the object did not come from it.
    if (object.size === 0) throw new BadRequestException('The file is empty')
    if (object.size > maxBytes) throw new BadRequestException(tooLarge(maxBytes))
    if (object.contentType !== declaredType) throw new BadRequestException('The file type does not match the job')
    return object.size
  }

  private newestFirst(user: AuthUser): Query {
    return this.firestore
      .collection(JOBS)
      .where('ownerId', '==', user.uid)
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
  }

  private summaries(docs: { id: string; data(): Record<string, unknown> }[]): JobSummary[] {
    return docs.flatMap((doc) => {
      const summary = toJobSummary(doc.id, doc.data())
      if (!summary) this.logger.warn({ jobId: doc.id }, 'Left out a job document that cannot be read')
      return summary ? [summary] : []
    })
  }

  private ref(jobId: string): DocumentReference {
    if (!jobIdSchema.safeParse(jobId).success) throw new NotFoundException('Job not found')
    return this.firestore.collection(JOBS).doc(jobId)
  }
}

/** Answer for a job whose document is gone, e.g. removed with its files after a week. */
export const NO_LONGER_AVAILABLE = 'The file is no longer available'

function tooLarge(maxBytes: number): string {
  return `The file must be at most ${formatBytes(maxBytes)}`
}

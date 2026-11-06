import type { CreateJobRequest, CreateJobResponse, QuotaErrorCode } from '@onetodone/compress-shared'

import { ApiError } from './api-error'
import { UploadError } from './upload'

/** Where a queued file is in the upload flow. */
export type QueuedStage = 'waiting' | 'creating' | 'uploading' | 'submitting' | 'submitted' | 'limited' | 'error'

/** A change to the state of a queued file. */
export interface QueuedPatch {
  stage?: QueuedStage
  /** Uploaded fraction from 0 to 1. */
  progress?: number
  jobId?: string | null
  /** User-safe reason of an `error`. */
  error?: string | null
  /** The limit that refused a `limited` file. */
  limit?: QuotaErrorCode | null
}

/** The calls the queue makes for each file; the API and R2 in the app, fakes in tests. */
export interface UploadSteps {
  create(request: CreateJobRequest): Promise<Pick<CreateJobResponse, 'jobId' | 'uploadUrl'>>
  upload(url: string, file: Blob, contentType: string, onProgress: (fraction: number) => void): Promise<void>
  submit(jobId: string): Promise<unknown>
  /** Deletes a job that will never be submitted, so it does not stay in the list as not uploaded. */
  discard(jobId: string): Promise<void>
}

interface Entry {
  key: string
  file: Blob
  request: CreateJobRequest
}

/** Number of files created and uploaded at the same time. */
export const UPLOAD_CONCURRENCY = 3

/**
 * Runs the upload flow (create the job, upload to R2, submit) for many files. A few files upload at
 * once and submits run one after another: every submit updates the same quota document, and
 * concurrent transactions on it only retry each other. When a submit or create is refused by a quota
 * limit, the files still waiting are marked as limited without being uploaded.
 */
export class UploadQueue {
  private readonly waiting: Entry[] = []
  private running = 0
  private unfinished = 0
  private submits: Promise<unknown> = Promise.resolve()

  /**
   * @param steps calls made for each file
   * @param onChange receives every change of a file's state
   * @param concurrency files created and uploaded at the same time
   */
  constructor(
    private readonly steps: UploadSteps,
    private readonly onChange: (key: string, patch: QueuedPatch) => void,
    private readonly concurrency = UPLOAD_CONCURRENCY,
  ) {}

  /** Files added and not yet submitted, refused or failed. */
  get pending(): number {
    return this.unfinished
  }

  /** Queues a file; it starts as soon as a slot is free. */
  add(key: string, file: Blob, request: CreateJobRequest): void {
    this.unfinished++
    this.waiting.push({ key, file, request })
    this.pump()
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!
      this.running++
      void this.process(entry).finally(() => {
        this.running--
        this.unfinished--
        this.pump()
      })
    }
  }

  private async process({ key, file, request }: Entry): Promise<void> {
    let jobId: string | null = null
    try {
      this.onChange(key, { stage: 'creating' })
      const created = await this.steps.create(request)
      jobId = created.jobId
      this.onChange(key, { stage: 'uploading', jobId })
      await this.steps.upload(created.uploadUrl, file, request.contentType, (progress) =>
        this.onChange(key, { progress }),
      )
      this.onChange(key, { stage: 'submitting', progress: 1 })
      await this.serialSubmit(created.jobId)
      this.onChange(key, { stage: 'submitted' })
    } catch (error) {
      if (error instanceof ApiError && error.quotaCode) {
        this.onChange(key, { stage: 'limited', limit: error.quotaCode, jobId: null })
        if (jobId) void this.steps.discard(jobId).catch(() => undefined)
        this.refuseWaiting(error.quotaCode)
        return
      }
      const message =
        error instanceof ApiError || error instanceof UploadError ? error.message : 'Something went wrong. Try again.'
      this.onChange(key, { stage: 'error', error: message })
    }
  }

  private serialSubmit(jobId: string): Promise<unknown> {
    const submit = this.submits.then(() => this.steps.submit(jobId))
    this.submits = submit.catch(() => undefined)
    return submit
  }

  private refuseWaiting(limit: QuotaErrorCode): void {
    for (const entry of this.waiting.splice(0)) {
      this.unfinished--
      this.onChange(entry.key, { stage: 'limited', limit })
    }
  }
}

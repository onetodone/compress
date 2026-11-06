import { Inject, Injectable, Logger } from '@nestjs/common'
import type { JobStatus } from '@onetodone/image-compressor-shared'
import {
  type DocumentData,
  type DocumentSnapshot,
  Firestore,
  type Query,
  type QueryDocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore'

import { ImageCdn } from '../../common/cloudinary/image-cdn.js'
import type { WorkerConfig } from '../../common/config/config.js'
import { CONFIG } from '../../common/config/config.module.js'
import { failJob, JOBS, removeJobFiles } from '../../common/jobs/job-records.js'
import { CallTimer } from '../../common/logging/call-timer.js'
import { ObjectStorage } from '../../common/r2/object-storage.js'
import { TaskQueue } from '../../common/tasks/task-queue.js'
import { RETRIES_EXHAUSTED } from '../compression/compression.service.js'
import { staleJobCutoffs } from './stale-jobs.js'

/** Documents read per query page. */
const PAGE_SIZE = 200

/** Jobs of one kind handled in one run at most; the rest waits for the next run. */
const MAX_JOBS_PER_KIND = 2000

const COMPRESSION_STATUSES: JobStatus[] = ['queued', 'processing']

/** What one cleanup run did. */
export interface CleanupResult {
  /** `awaiting_upload` jobs deleted with their originals. */
  abandonedUploads: number
  /** `queued` or `processing` jobs without a pending task, marked failed. */
  stuckJobs: number
  /** Jobs past the result lifetime, deleted with their files. */
  expiredJobs: number
  /** Jobs that could not be handled; they are tried again in the next run. */
  errors: number
}

/**
 * Removes jobs that will never finish or whose files are gone. Every step re-checks the job in a
 * transaction, so a run that is delivered twice, or races the API or the worker, changes nothing
 * that is still in use.
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly storage: ObjectStorage,
    private readonly cdn: ImageCdn,
    private readonly tasks: TaskQueue,
    private readonly timer: CallTimer,
    @Inject(CONFIG) private readonly config: WorkerConfig,
  ) {}

  /** Runs every cleanup step once, as of `now`. */
  async run(now = new Date()): Promise<CleanupResult> {
    const cutoffs = staleJobCutoffs(now, this.config)
    const jobs = this.firestore.collection(JOBS)
    const result: CleanupResult = { abandonedUploads: 0, stuckJobs: 0, expiredJobs: 0, errors: 0 }

    // Both status queries need the composite index on (status, updatedAt).
    const abandoned = jobs
      .where('status', '==', 'awaiting_upload')
      .where('updatedAt', '<', Timestamp.fromDate(cutoffs.upload))
    await this.each('jobs.abandonedUploads', abandoned, result, async (job) => {
      if (
        await this.deleteJob(job, (current) => current.get('status') === 'awaiting_upload' && unchanged(job, current))
      )
        result.abandonedUploads++
    })

    const stuck = jobs
      .where('status', 'in', COMPRESSION_STATUSES)
      .where('updatedAt', '<', Timestamp.fromDate(cutoffs.compression))
    await this.each('jobs.stuck', stuck, result, async (job) => {
      if (await this.timer.measure('redis', 'tasks.pending', () => this.tasks.hasPendingCompression(job.id))) return
      const failed = await this.timer.measure('firestore', 'jobs.fail', () =>
        failJob(this.firestore, job.id, RETRIES_EXHAUSTED, (current) => unchanged(job, current)),
      )
      if (failed) {
        this.logger.warn(
          { jobId: job.id, status: job.get('status') as string },
          'Job without a compression task failed',
        )
        result.stuckJobs++
      }
    })

    const expired = jobs.where('createdAt', '<', Timestamp.fromDate(cutoffs.expired))
    await this.each('jobs.expired', expired, result, async (job) => {
      if (await this.deleteJob(job, (current) => current.exists)) result.expiredJobs++
    })

    return result
  }

  /** Calls `handle` for every document of `query`, page by page, counting the documents that throw. */
  private async each(
    operation: string,
    query: Query,
    result: CleanupResult,
    handle: (job: QueryDocumentSnapshot) => Promise<void>,
  ): Promise<void> {
    let last: QueryDocumentSnapshot | undefined
    for (let seen = 0; seen < MAX_JOBS_PER_KIND;) {
      const page = last ? query.startAfter(last) : query
      const { docs } = await this.timer.measure('firestore', operation, () => page.limit(PAGE_SIZE).get())
      for (const job of docs) {
        try {
          await handle(job)
        } catch (error) {
          result.errors++
          this.logger.error({ jobId: job.id, operation, err: error }, 'Could not clean up a stale job')
        }
      }
      seen += docs.length
      last = docs.at(-1)
      if (docs.length < PAGE_SIZE) return
    }
  }

  /** Deletes the document if `applies` still holds inside the transaction, then the job's files. */
  private async deleteJob(
    job: QueryDocumentSnapshot,
    applies: (current: DocumentSnapshot) => boolean,
  ): Promise<boolean> {
    const deleted = await this.timer.measure('firestore', 'jobs.delete', () =>
      this.firestore.runTransaction(async (tx): Promise<DocumentData | null> => {
        const current = await tx.get(job.ref)
        if (!current.exists || !applies(current)) return null
        tx.delete(job.ref)
        return current.data()!
      }),
    )
    if (!deleted) return false
    for (const { file, error } of await removeJobFiles(this.storage, this.cdn, job.id, deleted)) {
      this.logger.error({ jobId: job.id, file, err: error }, 'Could not remove a file of a stale job')
    }
    return true
  }
}

/** Whether the job has not been written since the query saw it. */
function unchanged(seen: DocumentSnapshot, current: DocumentSnapshot): boolean {
  const before: unknown = seen.get('updatedAt')
  const after: unknown = current.get('updatedAt')
  return before instanceof Timestamp && after instanceof Timestamp && before.isEqual(after)
}

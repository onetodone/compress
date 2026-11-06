import { type JobStatus, TERMINAL_JOB_STATUSES, utcDayKey } from '@onetodone/image-compressor-shared'
import { z } from 'zod'
import {
  type DocumentData,
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore'

import type { ImageCdn } from '../cloudinary/image-cdn.js'
import { readStoredUsage, refundQuota } from '../quota/quota.js'
import type { ObjectStorage } from '../r2/object-storage.js'

/** Firestore collection of jobs. */
export const JOBS = 'jobs'

/** Firestore collection of users and their quota counters. */
export const USERS = 'users'

/** Where a job was created: the web app or the Telegram bot. */
export type JobSource = 'web' | 'telegram'

const chatTargetSchema = z.object({
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
})

/**
 * Telegram message a job was created from, stored as `notify` on the job. The bot replies to it with
 * the result or the error once the job is finished.
 */
export type ChatTarget = z.infer<typeof chatTargetSchema>

/**
 * Reads the chat message to answer when a job is finished. Returns `null` for jobs created on the
 * web, documents without the field and values this version cannot read.
 * @param job data of a job document
 */
export function readChatTarget(job: DocumentData | undefined): ChatTarget | null {
  const result = chatTargetSchema.safeParse(job?.notify)
  return result.success ? result.data : null
}

/**
 * Whether the owner of a finished job still has to be told about it in a chat: the job was created
 * from a chat message and no answer was recorded yet.
 * @param job data of a job document
 */
export function awaitsChatAnswer(job: DocumentData | undefined): boolean {
  return (
    readChatTarget(job) !== null && TERMINAL_JOB_STATUSES.includes(job?.status as JobStatus) && job?.notifiedAt == null
  )
}

/**
 * Marks a job `failed` and gives its quota unit back, in one transaction. `quotaRefunded` and the
 * terminal status guard the refund, so repeated calls never refund twice; nothing is given back once
 * the user's counter has rolled over to a day other than the one the unit was counted on.
 *
 * @param message short, user-safe reason stored in `error`
 * @param applies checked against the job inside the transaction; the job is left alone when it returns false
 * @returns the job as it was written, or `null` when it was left alone
 */
export function failJob(
  firestore: Firestore,
  jobId: string,
  message: string,
  applies: (job: DocumentSnapshot) => boolean = () => true,
): Promise<DocumentData | null> {
  const ref = firestore.collection(JOBS).doc(jobId)
  return firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)
    if (!snapshot.exists || TERMINAL_JOB_STATUSES.includes(snapshot.get('status') as JobStatus)) return null
    if (!applies(snapshot)) return null

    let quotaRefunded = snapshot.get('quotaRefunded') === true
    const dayKey = quotaDayKey(snapshot)
    if (!quotaRefunded && dayKey) {
      const userRef = firestore.collection(USERS).doc(snapshot.get('ownerId') as string)
      const refunded = refundQuota(readStoredUsage((await tx.get(userRef)).data()), dayKey)
      if (refunded) {
        tx.update(userRef, { jobsToday: refunded.jobsToday })
        quotaRefunded = true
      }
    }

    const now = FieldValue.serverTimestamp()
    const update = { status: 'failed', error: message, quotaRefunded, updatedAt: now, finishedAt: now }
    tx.update(ref, update)
    return { ...snapshot.data(), ...update }
  })
}

/** A file of a job that could not be removed, and why. */
export interface FileRemovalFailure {
  file: 'original' | 'result' | 'preview'
  error: unknown
}

/**
 * Removes the original, the result and the preview of a job whose document is already deleted.
 * Every removal is attempted; the ones that fail are returned for logging, as the bucket lifecycle
 * rules expire what is left in R2.
 *
 * @param job data of the deleted job document
 */
export async function removeJobFiles(
  storage: ObjectStorage,
  cdn: ImageCdn,
  jobId: string,
  job: DocumentData,
): Promise<FileRemovalFailure[]> {
  const removals: [FileRemovalFailure['file'], Promise<void>][] = []
  if (typeof job.inputKey === 'string') removals.push(['original', storage.delete(job.inputKey)])
  if (typeof job.outputKey === 'string') removals.push(['result', storage.delete(job.outputKey)])
  if (job.previewUrl != null) removals.push(['preview', cdn.delete(jobId)])
  const results = await Promise.allSettled(removals.map(([, removal]) => removal))
  return results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ file: removals[index]![0], error: result.reason }] : [],
  )
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

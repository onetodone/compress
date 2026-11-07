import { Injectable, Logger } from '@nestjs/common'
import { jobsUsedToday, utcDayKey } from '@onetodone/compress-shared'
import { FieldValue, Firestore } from 'firebase-admin/firestore'

import { JOBS } from '../jobs/job-records.js'
import { CallTimer } from '../logging/call-timer.js'
import { readStoredUsage } from '../quota/quota.js'
import { USERS } from './account-fields.js'

/** Jobs moved per transaction; well below Firestore's 500 writes per transaction. */
const MOVE_CHUNK = 100

/**
 * Moves the images and today's used quota of a uid nobody can reach any more into the account its
 * person continues with: an anonymous session left for an existing account, or the uid a Telegram
 * account leaves when it is linked to a website account.
 *
 * R2 keys and Cloudinary ids are stored on the job and do not depend on the owner, so only `ownerId`
 * changes. Running it again moves whatever is left, so an interrupted merge can be repeated.
 */
@Injectable()
export class LibraryMergeService {
  private readonly logger = new Logger(LibraryMergeService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly timer: CallTimer,
  ) {}

  /**
   * Moves every job of `fromUid` to `toUid`, then adds today's used count of `fromUid` to `toUid`, so
   * merging never adds free jobs. Jobs move first: a refund of a moved job then reaches `toUid`,
   * whose count already includes the unit.
   *
   * @returns the number of jobs moved
   */
  async merge(fromUid: string, toUid: string, now = new Date()): Promise<number> {
    if (fromUid === toUid) return 0
    let moved = 0
    for (;;) {
      const count = await this.timer.measure('firestore', 'jobs.moveOwner', () => this.moveChunk(fromUid, toUid))
      moved += count
      if (count < MOVE_CHUNK) break
    }
    await this.timer.measure('firestore', 'users.mergeUsage', () => this.mergeUsage(fromUid, toUid, now))
    this.logger.log({ userId: toUid, fromUserId: fromUid, movedJobs: moved }, 'Merged a library into an account')
    return moved
  }

  private moveChunk(fromUid: string, toUid: string): Promise<number> {
    const query = this.firestore.collection(JOBS).where('ownerId', '==', fromUid).limit(MOVE_CHUNK)
    // A transaction, not a batch: a job deleted meanwhile must not fail the move or come back as a stub.
    return this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(query)
      for (const job of snapshot.docs) tx.update(job.ref, { ownerId: toUid })
      return snapshot.size
    })
  }

  private mergeUsage(fromUid: string, toUid: string, now: Date): Promise<void> {
    const fromRef = this.firestore.collection(USERS).doc(fromUid)
    const toRef = this.firestore.collection(USERS).doc(toUid)
    return this.firestore.runTransaction(async (tx) => {
      const [from, to] = await tx.getAll(fromRef, toRef)
      const fromUsed = jobsUsedToday(readStoredUsage(from!.data()), now)
      if (fromUsed === 0) return
      const usage = { dayKey: utcDayKey(now), jobsToday: jobsUsedToday(readStoredUsage(to!.data()), now) + fromUsed }
      if (to!.exists) tx.update(toRef, usage)
      else tx.set(toRef, { ...usage, createdAt: FieldValue.serverTimestamp() })
      tx.update(fromRef, { jobsToday: 0 })
    })
  }
}

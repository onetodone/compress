import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { type Quota, type QuotaErrorCode, utcDayKey } from '@onetodone/compress-shared'
import { FieldValue, Firestore, type Transaction } from 'firebase-admin/firestore'

import type { CompressionToolsConfig, QuotaConfig } from '../config/config.js'
import { CONFIG } from '../config/config.module.js'
import { type Entitlements, entitlementsFor } from '../entitlements/entitlements.js'
import { CallTimer } from '../logging/call-timer.js'
import { networkOf } from './network.js'
import { consumeQuota, currentQuota, readStoredUsage } from './quota.js'
import type { AuthUser } from '../auth/auth-user.js'
import { NetworkQuota } from './network-quota.js'

const USERS = 'users'

/** A job counted against the limit of a client network, to give back if the submit does not happen. */
export interface NetworkReservation {
  network: string
  dayKey: string
}

function limitReached(code: QuotaErrorCode, message: string): HttpException {
  return new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message, code }, HttpStatus.TOO_MANY_REQUESTS)
}

/**
 * Reads and consumes the daily job quota stored in `users/{uid}`, and the limit on anonymous jobs
 * per client network that keeps fresh anonymous sessions from adding free jobs without bound.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name)

  constructor(
    private readonly firestore: Firestore,
    private readonly networks: NetworkQuota,
    private readonly timer: CallTimer,
    @Inject(CONFIG) private readonly config: QuotaConfig & CompressionToolsConfig,
  ) {}

  /** Returns what the user may do: daily jobs, file types and sizes, and whether the network limit applies. */
  entitlements(user: AuthUser): Entitlements {
    return entitlementsFor(user, 'free', this.config)
  }

  async get(user: AuthUser, now = new Date()): Promise<Quota> {
    const snapshot = await this.timer.measure('firestore', 'users.get', () => this.ref(user.uid).get())
    return currentQuota(readStoredUsage(snapshot.data()), this.entitlements(user).dailyJobs, now)
  }

  /** Whether the client network of an anonymous user has no jobs left today. */
  async networkLimitReached(user: AuthUser, ip: string | undefined, now = new Date()): Promise<boolean> {
    const limit = this.networkLimit(user)
    if (limit === null) return false
    return (await this.networks.used(networkOf(ip), utcDayKey(now))) >= limit
  }

  /**
   * Refuses a job early when the user or, for an anonymous user, the client network has no jobs left
   * today. Nothing is counted; {@link consume} and {@link reserveNetwork} do that on submit.
   *
   * @throws HttpException 429 when a limit is reached
   */
  async assertAvailable(user: AuthUser, ip: string | undefined, now = new Date()): Promise<void> {
    const quota = await this.get(user, now)
    if (quota.used >= quota.limit) throw limitReached('daily_limit', 'Daily job limit reached')
    if (await this.networkLimitReached(user, ip, now)) {
      throw limitReached('network_daily_limit', 'Daily job limit of this network reached')
    }
  }

  /**
   * Counts one job against the client network of an anonymous user. Returns `null` when the user is
   * not limited per network (registered user or limit disabled).
   *
   * @throws HttpException 429 when the network has no jobs left today
   */
  async reserveNetwork(user: AuthUser, ip: string | undefined, now = new Date()): Promise<NetworkReservation | null> {
    const limit = this.networkLimit(user)
    if (limit === null) return null
    const reservation = { network: networkOf(ip), dayKey: utcDayKey(now) }
    if (!(await this.networks.reserve(reservation.network, reservation.dayKey, limit))) {
      throw limitReached('network_daily_limit', 'Daily job limit of this network reached')
    }
    return reservation
  }

  /** Gives back a network reservation; a failure is logged, since the counter expires anyway. */
  async releaseNetwork(reservation: NetworkReservation): Promise<void> {
    try {
      await this.networks.release(reservation.network, reservation.dayKey)
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not release a network quota reservation')
    }
  }

  /**
   * Counts one job against today's quota inside the caller's transaction, so the quota and the
   * job status change together. Firestore requires all reads before any write in a transaction,
   * so call this before writing anything else.
   *
   * @throws HttpException 429 when the daily limit is reached
   */
  async consume(tx: Transaction, user: AuthUser, now = new Date()): Promise<Quota> {
    const ref = this.ref(user.uid)
    const snapshot = await tx.get(ref)
    const quota = consumeQuota(readStoredUsage(snapshot.data()), this.entitlements(user).dailyJobs, now)
    if (!quota) throw limitReached('daily_limit', 'Daily job limit reached')

    const fields = { dayKey: quota.dayKey, jobsToday: quota.used, isAnonymous: user.kind === 'anonymous' }
    if (snapshot.exists) tx.update(ref, fields)
    else tx.set(ref, { ...fields, createdAt: FieldValue.serverTimestamp() })
    return quota
  }

  private networkLimit(user: AuthUser): number | null {
    return this.entitlements(user).networkLimited ? this.config.QUOTA_ANONYMOUS_PER_IP_DAILY : null
  }

  private ref(uid: string) {
    return this.firestore.collection(USERS).doc(uid)
  }
}

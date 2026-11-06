import { MAX_INPUT_BYTES } from '@onetodone/image-compressor-shared'

import type { AuthUser } from '../auth/auth-user.js'
import type { QuotaConfig } from '../config/config.js'

/** Plan a user is on; every user is on `free` until paid plans exist. */
export type Plan = 'free'

/** Everything a user may do, derived from the kind of account and the plan. */
export interface Entitlements {
  /** Jobs per UTC day. */
  dailyJobs: number
  /** Largest original image, in bytes; never above {@link MAX_INPUT_BYTES}. */
  maxInputBytes: number
  /**
   * Whether the user's jobs also count against the daily limit of their client network. Only
   * anonymous sessions are, since anyone can start a fresh one; callers without a client address
   * would otherwise all share one network.
   */
  networkLimited: boolean
}

/**
 * Returns the limits of a user. The only place that decides them: quotas, upload checks and
 * `GET /me` all read from here.
 *
 * @param user the user's account
 * @param plan the user's plan
 * @param config configured quota limits
 */
export function entitlementsFor(user: Pick<AuthUser, 'kind'>, plan: Plan, config: QuotaConfig): Entitlements {
  const anonymous = user.kind === 'anonymous'
  return {
    dailyJobs: anonymous ? config.QUOTA_ANONYMOUS_DAILY : config.QUOTA_SIGNED_IN_DAILY,
    maxInputBytes: MAX_INPUT_BYTES,
    networkLimited: anonymous && config.QUOTA_ANONYMOUS_PER_IP_DAILY > 0,
  }
}

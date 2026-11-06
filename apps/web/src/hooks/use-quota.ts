'use client'

import { jobsUsedToday, type MeResponse, type Quota, type UserLimits, utcDayKey } from '@onetodone/compress-shared'
import { doc, onSnapshot } from 'firebase/firestore'
import { useEffect, useRef, useState } from 'react'

import { api } from '@/lib/api'
import { getFirebase } from '@/lib/firebase'

const RETRY_MS = 5_000

/** The user's quota and limits, and whether their network may still submit anonymous jobs. */
export interface QuotaState {
  /** `null` until both the used count and the limit have arrived. */
  quota: Quota | null
  /** Per-file limits; `null` until `GET /me` has answered once. */
  limits: UserLimits | null
  /** `GET /me` failed before any limits arrived; it is retried. */
  limitsFailed: boolean
  /** The client's network has used up its anonymous jobs for today. */
  networkLimitReached: boolean
}

type MeState = Pick<MeResponse, 'limits' | 'networkLimitReached'> & { dailyJobs: number }

/**
 * Returns the user's quota and limits. The used count is updated live from `users/{uid}`, so submits
 * and refunds show up without a reload; the limits and the network state come from `GET /me`, which
 * is the authority on them, and are fetched again when the used count or the account kind changes.
 *
 * @param uid signed-in user
 * @param kind account kind of the user
 */
export function useQuota(uid: string, kind: MeResponse['kind']): QuotaState {
  const [used, setUsed] = useState<number | null>(null)
  const [me, setMe] = useState<MeState | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const known = useRef(false)

  useEffect(() => {
    return onSnapshot(doc(getFirebase().firestore, 'users', uid), (snapshot) => {
      const data = snapshot.data()
      const stored =
        typeof data?.dayKey === 'string' && typeof data.jobsToday === 'number'
          ? { dayKey: data.dayKey, jobsToday: data.jobsToday }
          : undefined
      setUsed(jobsUsedToday(stored, new Date()))
    })
  }, [uid])

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    api.me().then(
      (response) => {
        if (cancelled) return
        known.current = true
        setMe({
          dailyJobs: response.quota.limit,
          limits: response.limits,
          networkLimitReached: response.networkLimitReached,
        })
        setFailed(false)
      },
      () => {
        // Once limits are known the last state is kept; submits enforce the real limits on the server.
        if (cancelled || known.current) return
        setFailed(true)
        retry = setTimeout(() => setAttempt((count) => count + 1), RETRY_MS)
      },
    )
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [uid, kind, used, attempt])

  return {
    quota: used === null || me === null ? null : { dayKey: utcDayKey(new Date()), used, limit: me.dailyJobs },
    limits: me?.limits ?? null,
    limitsFailed: me === null && failed,
    networkLimitReached: me?.networkLimitReached ?? false,
  }
}

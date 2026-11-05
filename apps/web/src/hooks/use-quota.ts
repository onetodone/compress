'use client'

import { jobsUsedToday, type MeResponse, type Quota, utcDayKey } from '@onetodone/image-compressor-shared'
import { doc, onSnapshot } from 'firebase/firestore'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { getFirebase } from '@/lib/firebase'

/** The user's quota for today and whether their network may still submit anonymous jobs. */
export interface QuotaState {
  /** `null` until both the used count and the limit have arrived. */
  quota: Quota | null
  /** The client's network has used up its anonymous jobs for today. */
  networkLimitReached: boolean
}

/**
 * Returns the user's quota for today. The used count is updated live from `users/{uid}`, so submits
 * and refunds show up without a reload; the limit and the network state come from `GET /me`, which
 * is the authority on them, and are fetched again when the used count or the anonymous flag changes.
 *
 * @param uid signed-in user
 * @param isAnonymous whether the user is anonymous
 */
export function useQuota(uid: string, isAnonymous: boolean): QuotaState {
  const [used, setUsed] = useState<number | null>(null)
  const [me, setMe] = useState<(Pick<MeResponse, 'networkLimitReached'> & { limit: number }) | null>(null)

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
    api.me().then(
      (response) => {
        if (!cancelled) setMe({ limit: response.quota.limit, networkLimitReached: response.networkLimitReached })
      },
      () => {
        // Keeps the last known state; submits enforce the real limits on the server.
      },
    )
    return () => {
      cancelled = true
    }
  }, [uid, isAnonymous, used])

  return {
    quota: used === null || me === null ? null : { dayKey: utcDayKey(new Date()), used, limit: me.limit },
    networkLimitReached: me?.networkLimitReached ?? false,
  }
}

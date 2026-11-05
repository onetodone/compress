'use client'

import { jobsUsedToday, type Quota, utcDayKey } from '@onetodone/image-compressor-shared'
import { doc, onSnapshot } from 'firebase/firestore'
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { getFirebase } from '@/lib/firebase'

/**
 * Returns the user's quota for today. The used count is updated live from `users/{uid}`, so submits
 * and refunds show up without a reload; the limit comes from `GET /me`, which is the authority on
 * it, and is fetched again when the user stops being anonymous. `null` until both have arrived.
 *
 * @param uid signed-in user
 * @param isAnonymous whether the user is anonymous; a change refetches the limit
 */
export function useQuota(uid: string, isAnonymous: boolean): Quota | null {
  const [used, setUsed] = useState<number | null>(null)
  const [limit, setLimit] = useState<number | null>(null)

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
      (me) => {
        if (!cancelled) setLimit(me.quota.limit)
      },
      () => {
        // The meter keeps the last known limit; submits enforce the real one on the server.
      },
    )
    return () => {
      cancelled = true
    }
  }, [uid, isAnonymous])

  if (used === null || limit === null) return null
  return { dayKey: utcDayKey(new Date()), used, limit }
}

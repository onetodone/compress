'use client'

import { isTerminalJobStatus, type JobSummary, toJobSummary } from '@onetodone/image-compressor-shared'
import { doc, onSnapshot } from 'firebase/firestore'
import { useEffect, useState } from 'react'

import { getFirebase } from '@/lib/firebase'

/** Latest state of a job, and whether live updates stopped. */
export interface LiveJob {
  job: JobSummary | null
  error: string | null
}

/**
 * Follows a job document in real time until it reaches a terminal status.
 * @param jobId job to follow, or `null` while there is none yet
 * @param initial last known state; a finished job is returned as is without listening
 */
export function useLiveJob(jobId: string | null, initial: JobSummary | null = null): LiveJob {
  const [job, setJob] = useState<JobSummary | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const finished = initial !== null && isTerminalJobStatus(initial.status)

  useEffect(() => {
    if (!jobId || finished) return
    const unsubscribe = onSnapshot(
      doc(getFirebase().firestore, 'jobs', jobId),
      (snapshot) => {
        const data = snapshot.data()
        const summary = data ? toJobSummary(snapshot.id, data) : null
        if (!summary) return
        setJob(summary)
        // A finished job never changes again, so there is nothing left to listen for.
        if (isTerminalJobStatus(summary.status)) unsubscribe()
      },
      () => setError('Live updates stopped. Reload the page to refresh.'),
    )
    return unsubscribe
  }, [jobId, finished])

  return { job, error }
}

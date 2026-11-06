'use client'

import { isTerminalJobStatus, type JobSummary, toJobSummary } from '@onetodone/image-compressor-shared'
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { useEffect, useMemo, useRef, useState } from 'react'

import { getFirebase } from '@/lib/firebase'

/** A job to follow and its last known state, if any. */
export interface LiveJobEntry {
  id: string
  initial: JobSummary | null
}

/** Latest state of the followed jobs. */
export interface LiveJobs {
  /** Latest state by job id; jobs without any known state yet are missing. */
  jobs: ReadonlyMap<string, JobSummary>
  /** Jobs whose live updates stopped with an error. */
  stopped: ReadonlySet<string>
}

/**
 * Follows jobs in real time until each reaches a terminal status. Finished jobs are not listened to.
 * @param entries jobs to follow; a job that leaves the list stops being followed
 */
export function useLiveJobs(entries: readonly LiveJobEntry[]): LiveJobs {
  const [live, setLive] = useState<ReadonlyMap<string, JobSummary>>(new Map())
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set())
  const subscriptions = useRef(new Map<string, Unsubscribe>())

  const jobs = useMemo(() => {
    const merged = new Map<string, JobSummary>()
    for (const { id, initial } of entries) {
      const job = live.get(id) ?? initial
      if (job) merged.set(id, job)
    }
    return merged
  }, [entries, live])

  // Joined into a string so the effect runs only when the set of running jobs changes.
  const runningKey = entries
    .filter(({ id }) => {
      const job = jobs.get(id)
      return !job || !isTerminalJobStatus(job.status)
    })
    .map(({ id }) => id)
    .join(',')

  useEffect(() => {
    const running = new Set(runningKey === '' ? [] : runningKey.split(','))
    const current = subscriptions.current
    for (const [id, unsubscribe] of current) {
      if (running.has(id)) continue
      unsubscribe()
      current.delete(id)
    }
    for (const id of running) {
      if (current.has(id)) continue
      const unsubscribe = onSnapshot(
        doc(getFirebase().firestore, 'jobs', id),
        (snapshot) => {
          const data = snapshot.data()
          const summary = data ? toJobSummary(snapshot.id, data) : null
          if (summary) setLive((jobs) => new Map(jobs).set(id, summary))
        },
        () => setStopped((ids) => new Set(ids).add(id)),
      )
      current.set(id, unsubscribe)
    }
  }, [runningKey])

  useEffect(() => {
    const current = subscriptions.current
    return () => {
      for (const unsubscribe of current.values()) unsubscribe()
      current.clear()
    }
  }, [])

  return { jobs, stopped }
}

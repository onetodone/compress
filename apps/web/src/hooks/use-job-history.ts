'use client'

import type { JobSummary } from '@onetodone/compress-shared'
import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { ApiError } from '@/lib/api-error'

/** Pages of the user's earlier jobs loaded so far. */
export interface JobHistory {
  jobs: JobSummary[]
  status: 'loading' | 'idle' | 'error'
  error: string | null
  hasMore: boolean
  loadMore: () => void
  /** Drops a deleted job from the list. */
  removeJob: (jobId: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Could not load your jobs.'
}

/**
 * Loads the user's jobs from `GET /jobs`, newest first, one page at a time.
 * @param uid signed-in user
 */
export function useJobHistory(uid: string): JobHistory {
  const [state, setState] = useState<
    Omit<JobHistory, 'loadMore' | 'removeJob'> & { uid: string | null; cursor: string | null }
  >({
    uid: null,
    jobs: [],
    status: 'loading',
    error: null,
    hasMore: false,
    cursor: null,
  })

  useEffect(() => {
    let cancelled = false
    api.listJobs(null).then(
      (page) => {
        if (cancelled) return
        setState({
          uid,
          jobs: page.jobs,
          status: 'idle',
          error: null,
          hasMore: page.nextCursor !== null,
          cursor: page.nextCursor,
        })
      },
      (error: unknown) => {
        if (cancelled) return
        setState({ uid, jobs: [], status: 'error', error: errorMessage(error), hasMore: false, cursor: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [uid])

  const { cursor, status } = state
  const loadMore = useCallback(() => {
    if (!cursor || status === 'loading') return
    setState((current) => ({ ...current, status: 'loading', error: null }))
    api.listJobs(cursor).then(
      (page) =>
        setState((current) => {
          const known = new Set(current.jobs.map((job) => job.id))
          return {
            ...current,
            jobs: [...current.jobs, ...page.jobs.filter((job) => !known.has(job.id))],
            status: 'idle',
            hasMore: page.nextCursor !== null,
            cursor: page.nextCursor,
          }
        }),
      (error: unknown) => setState((current) => ({ ...current, status: 'error', error: errorMessage(error) })),
    )
  }, [cursor, status])

  const removeJob = useCallback((jobId: string) => {
    setState((current) => ({ ...current, jobs: current.jobs.filter((job) => job.id !== jobId) }))
  }, [])

  if (state.uid !== uid) return { jobs: [], status: 'loading', error: null, hasMore: false, loadMore, removeJob }
  const { jobs, error, hasMore } = state
  return { jobs, status, error, hasMore, loadMore, removeJob }
}

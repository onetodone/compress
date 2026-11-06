import type { JobSummary } from '@onetodone/compress-shared'

import { ApiError } from './api-error'
import { resultFileName } from './files'
import { buildZip, uniqueFileNames } from './zip'

/** The calls needed to fetch results; the API and R2 in the app, fakes in tests. */
export interface ResultSource {
  /** Returns a short-lived URL of a job's result. */
  resultUrl(jobId: string): Promise<string>
  /** Fetches the bytes behind a URL. */
  fetchBytes(url: string): Promise<Uint8Array>
}

/** An archive of results and the jobs that could not be added to it. */
export interface ResultArchive {
  /** `null` when no result could be fetched. */
  zip: Uint8Array<ArrayBuffer> | null
  failed: number
}

/** Results fetched at the same time. */
const FETCH_CONCURRENCY = 4

/**
 * Fetches the results of finished jobs and packs them into one ZIP, each under the name a single
 * download would give it. A result that cannot be fetched is left out and counted.
 * @param jobs finished jobs, in archive order
 * @param source where the results come from
 * @param onProgress receives the number of jobs handled so far
 */
export async function archiveResults(
  jobs: readonly JobSummary[],
  source: ResultSource,
  onProgress: (handled: number) => void = () => undefined,
): Promise<ResultArchive> {
  const names = uniqueFileNames(jobs.map(resultFileName))
  const data: (Uint8Array | null)[] = Array.from({ length: jobs.length }, () => null)
  let next = 0
  let handled = 0

  async function work(): Promise<void> {
    while (next < jobs.length) {
      const index = next++
      try {
        data[index] = await source.fetchBytes(await source.resultUrl(jobs[index]!.id))
      } catch {
        data[index] = null
      }
      onProgress(++handled)
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, jobs.length) }, work))

  const entries = names.flatMap((name, index) => {
    const bytes = data[index]
    return bytes ? [{ name, data: bytes }] : []
  })
  return { zip: entries.length > 0 ? buildZip(entries) : null, failed: jobs.length - entries.length }
}

/**
 * Fetches a presigned R2 URL from the browser. The bucket's CORS policy must allow `GET` from the
 * web origin.
 * @param url presigned `GET` URL
 */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new ApiError(0, 'Cannot reach the storage. Check your connection.')
  }
  if (!response.ok) throw new ApiError(response.status, 'A file could not be downloaded.')
  return new Uint8Array(await response.arrayBuffer())
}

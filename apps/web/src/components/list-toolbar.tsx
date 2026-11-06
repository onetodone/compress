'use client'

import { formatBytes, type JobSummary } from '@onetodone/compress-shared'
import { useState } from 'react'

import { BUTTON } from '@/components/job-card'
import { api } from '@/lib/api'
import { archiveResults, fetchBytes } from '@/lib/download-all'
import { savedPercent } from '@/lib/files'

/** Counts of the images picked in this session. */
export interface UploadTotals {
  total: number
  done: number
  /** Refused, failed or not uploaded. */
  failed: number
  inputBytes: number
  outputBytes: number
}

const ARCHIVE_NAME = 'compressed-images.zip'

function saveFile(data: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // The download has started once click() returns, but some browsers read the URL a moment later.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function DownloadAll({ jobs }: { jobs: readonly JobSummary[] }) {
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function run() {
    setProgress(0)
    setMessage(null)
    try {
      const { zip, failed } = await archiveResults(
        jobs,
        { resultUrl: async (jobId) => (await api.downloadJob(jobId)).url, fetchBytes },
        setProgress,
      )
      if (zip) saveFile(zip, ARCHIVE_NAME)
      if (failed > 0) {
        setMessage(
          zip
            ? `${failed} of ${jobs.length} images could not be added. Try again.`
            : 'The images could not be downloaded. Try again.',
        )
      }
    } catch {
      setMessage('The images could not be downloaded. Try again.')
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={BUTTON} disabled={progress !== null} onClick={() => void run()}>
        {progress === null ? `Download all (${jobs.length})` : `Preparing ${progress} of ${jobs.length}…`}
      </button>
      {message && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      )}
    </div>
  )
}

interface ListToolbarProps {
  /** `null` when nothing was picked in this session. */
  totals: UploadTotals | null
  /** Finished jobs in the list, in list order. */
  downloadable: readonly JobSummary[]
  /** Number of uploads of this session that are no longer running. */
  finished: number
  onClearFinished: () => void
}

/** Progress of this session's uploads and actions on the whole list. */
export function ListToolbar({ totals, downloadable, finished, onClearFinished }: ListToolbarProps) {
  if (!totals && downloadable.length === 0) return null
  const saved = totals ? totals.inputBytes - totals.outputBytes : 0
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400" aria-live="polite">
        {totals && (
          <>
            <span className="font-medium text-zinc-900 tabular-nums dark:text-zinc-100">
              {totals.done} of {totals.total}
            </span>{' '}
            done
            {totals.failed > 0 && <span className="tabular-nums"> · {totals.failed} not compressed</span>}
            {saved > 0 && (
              <span className="text-emerald-600 tabular-nums dark:text-emerald-400">
                {' '}
                · {formatBytes(saved)} saved ({savedPercent(totals.inputBytes, totals.outputBytes)}%)
              </span>
            )}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        {finished > 0 && (
          <button type="button" className={BUTTON} onClick={onClearFinished}>
            Clear finished
          </button>
        )}
        {downloadable.length > 0 && <DownloadAll jobs={downloadable} />}
      </div>
    </div>
  )
}

'use client'

import type { JobSummary, JobSummaryStatus } from '@onetodone/image-compressor-shared'
import Image from 'next/image'
import { type ReactNode, useState } from 'react'

import { useResultUrl } from '@/hooks/use-result-url'
import type { Upload } from '@/hooks/use-uploads'
import { api } from '@/lib/api'
import { ApiError, quotaLimitMessage } from '@/lib/api-error'
import { formatBytes, savedPercent } from '@/lib/files'

const STATUS_LABELS: Record<JobSummaryStatus, string> = {
  awaiting_upload: 'Not uploaded',
  queued: 'Queued',
  processing: 'Compressing…',
  done: 'Done',
  failed: 'Failed',
  unknown: 'Reload the page to see the latest state',
}

const UPLOAD_LABELS: Record<Extract<Upload['stage'], 'waiting' | 'creating' | 'uploading' | 'submitting'>, string> = {
  waiting: 'Waiting…',
  creating: 'Preparing…',
  uploading: 'Uploading…',
  submitting: 'Queuing…',
}

export const BUTTON =
  'rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'

function actionError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.'
}

/** Download (for finished jobs) and delete buttons, with the error of the last failed action. */
function JobActions({ jobId, canDownload, onDeleted }: { jobId: string; canDownload: boolean; onDeleted: () => void }) {
  const [busy, setBusy] = useState<'download' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(action: 'download' | 'delete') {
    setBusy(action)
    setError(null)
    try {
      if (action === 'download') {
        // The URL is served as an attachment, so the browser saves the file and stays on the page.
        window.location.assign((await api.downloadJob(jobId)).url)
      } else {
        await api.deleteJob(jobId)
        onDeleted()
        return
      }
    } catch (caught) {
      setError(actionError(caught))
    }
    setBusy(null)
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-2">
        {canDownload && (
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void run('download')}>
            {busy === 'download' ? 'Preparing…' : 'Download'}
          </button>
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm('Delete this image and its compressed version?')) void run('delete')
          }}
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

/** Small picture of a finished job: the CDN preview, or the result itself when there is no preview. */
function Thumbnail({ job }: { job: JobSummary | null }) {
  const done = job?.status === 'done'
  const resultUrl = useResultUrl(done && !job.previewUrl ? job.id : null)
  const src = done ? (job.previewUrl ?? resultUrl) : null
  return (
    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
      {src && <Image src={src} alt="" fill sizes="56px" className="object-cover" />}
    </div>
  )
}

function Problem({ children }: { children: ReactNode }) {
  return <p className="text-sm text-red-600 dark:text-red-400">{children}</p>
}

function Progress({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-zinc-500 dark:text-zinc-400">{label}</span>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : Math.round(value * 100)}
        className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div
          className={`h-full rounded-full bg-emerald-500 transition-[width] ${value === null ? 'w-1/3 animate-pulse' : ''}`}
          style={value === null ? undefined : { width: `${value * 100}%` }}
        />
      </div>
    </div>
  )
}

function Result({ job }: { job: JobSummary }) {
  if (job.inputBytes === null || job.outputBytes === null) return null
  const percent = savedPercent(job.inputBytes, job.outputBytes)
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="tabular-nums">
        {formatBytes(job.inputBytes)} → {formatBytes(job.outputBytes)}
      </span>
      {percent > 0 ? (
        <span className="font-medium text-emerald-600 dark:text-emerald-400">{percent}% smaller</span>
      ) : (
        <span className="text-zinc-500 dark:text-zinc-400">Already optimized, kept as is</span>
      )}
      {job.width && job.height && (
        <span className="text-zinc-500 dark:text-zinc-400">
          {job.width}×{job.height}
        </span>
      )}
    </p>
  )
}

function JobState({ job, liveStopped }: { job: JobSummary; liveStopped: boolean }) {
  if (job.status === 'done') return <Result job={job} />
  if (job.status === 'failed') return <Problem>{job.error ?? 'The image could not be compressed.'}</Problem>
  if (job.status === 'awaiting_upload' || job.status === 'unknown') {
    return <span className="text-sm text-zinc-500 dark:text-zinc-400">{STATUS_LABELS[job.status]}</span>
  }
  return (
    <>
      <Progress label={STATUS_LABELS[job.status]} value={null} />
      {liveStopped && <Problem>Live updates stopped. Reload the page to refresh.</Problem>}
    </>
  )
}

function UploadState({ upload, isAnonymous }: { upload: Upload; isAnonymous: boolean }) {
  switch (upload.stage) {
    case 'rejected':
    case 'error':
      return <Problem>{upload.error}</Problem>
    case 'limited':
      return (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {quotaLimitMessage(upload.limit ?? 'daily_limit', isAnonymous)}
        </p>
      )
    case 'waiting':
      return <span className="text-sm text-zinc-500 dark:text-zinc-400">{UPLOAD_LABELS.waiting}</span>
    case 'submitted':
      return <Progress label={STATUS_LABELS.queued} value={null} />
    default:
      return (
        <Progress label={UPLOAD_LABELS[upload.stage]} value={upload.stage === 'uploading' ? upload.progress : null} />
      )
  }
}

interface JobCardProps {
  /** The file as picked in this session, or `null` for a job from an earlier visit. */
  upload: Upload | null
  /** Latest known state of the job, once there is one. */
  job: JobSummary | null
  liveStopped: boolean
  isAnonymous: boolean
  /** Removes the card after the job was deleted or a refused file was dismissed. */
  onRemove: () => void
}

/** One image of the list: the upload while it runs, then the live job with its result. */
export function JobCard({ upload, job, liveStopped, isAnonymous, onRemove }: JobCardProps) {
  const name = job?.originalName ?? upload?.name ?? ''
  const jobId = job?.id ?? upload?.jobId ?? null
  // While the file is still being uploaded there is nothing to delete yet.
  const settled = !upload || upload.stage === 'submitted' || upload.stage === 'error'
  const dismissible = upload?.stage === 'rejected' || upload?.stage === 'limited'

  return (
    <article className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <Thumbnail job={job} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="min-w-0 truncate text-sm font-medium" title={name}>
          {name}
        </h3>
        {job && (!upload || upload.stage === 'submitted') ? (
          <JobState job={job} liveStopped={liveStopped} />
        ) : upload ? (
          <UploadState upload={upload} isAnonymous={isAnonymous} />
        ) : null}
      </div>
      {jobId && settled ? (
        <JobActions jobId={jobId} canDownload={job?.status === 'done'} onDeleted={onRemove} />
      ) : dismissible ? (
        <button type="button" className={BUTTON} onClick={onRemove}>
          Dismiss
        </button>
      ) : null}
    </article>
  )
}

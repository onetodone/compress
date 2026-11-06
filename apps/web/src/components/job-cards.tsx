'use client'

import type { JobSummary, JobSummaryStatus } from '@onetodone/image-compressor-shared'
import Image from 'next/image'
import { type ReactNode, useState } from 'react'

import { BeforeAfter } from '@/components/before-after'
import { useLiveJob } from '@/hooks/use-live-job'
import { useResultUrl } from '@/hooks/use-result-url'
import type { Upload } from '@/hooks/use-uploads'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/api-error'
import { formatBytes, savedPercent } from '@/lib/files'

const STATUS_LABELS: Record<JobSummaryStatus, string> = {
  awaiting_upload: 'Not uploaded',
  queued: 'Queued',
  processing: 'Compressing…',
  done: 'Done',
  failed: 'Failed',
  unknown: 'Reload the page to see the latest state',
}

const UPLOAD_LABELS: Record<Exclude<Upload['stage'], 'submitted' | 'rejected' | 'error'>, string> = {
  creating: 'Preparing…',
  uploading: 'Uploading…',
  submitting: 'Queuing…',
}

function Card({ name, actions, children }: { name: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-sm font-medium" title={name}>
          {name}
        </h3>
        {actions}
      </header>
      {children}
    </article>
  )
}

const BUTTON =
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
function Thumbnail({ job }: { job: JobSummary }) {
  const done = job.status === 'done'
  const resultUrl = useResultUrl(done && !job.previewUrl ? job.id : null)
  const src = job.previewUrl ?? resultUrl
  if (!done) return null
  return (
    <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
      {src && <Image src={src} alt="" fill sizes="64px" className="object-cover" />}
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

function JobState({ job, liveError }: { job: JobSummary; liveError: string | null }) {
  if (job.status === 'done') return <Result job={job} />
  if (job.status === 'failed') return <Problem>{job.error ?? 'The image could not be compressed.'}</Problem>
  if (job.status === 'awaiting_upload' || job.status === 'unknown') {
    return <span className="text-sm text-zinc-500 dark:text-zinc-400">{STATUS_LABELS[job.status]}</span>
  }
  return (
    <>
      <Progress label={STATUS_LABELS[job.status]} value={null} />
      {liveError && <Problem>{liveError}</Problem>}
    </>
  )
}

/** A file picked in this session: upload progress, then the live job with a before/after view. */
export function UploadCard({ upload, onRemove }: { upload: Upload; onRemove: () => void }) {
  const { job, error } = useLiveJob(upload.stage === 'submitted' ? upload.jobId : null)
  // The comparison shows the file the user downloads, not a CDN rendition of it.
  const resultUrl = useResultUrl(job?.status === 'done' ? job.id : null)

  let body: ReactNode
  if (upload.stage === 'rejected' || upload.stage === 'error') body = <Problem>{upload.error}</Problem>
  else if (upload.stage !== 'submitted') {
    body = (
      <Progress label={UPLOAD_LABELS[upload.stage]} value={upload.stage === 'uploading' ? upload.progress : null} />
    )
  } else if (!job) body = <Progress label={STATUS_LABELS.queued} value={null} />
  else body = <JobState job={job} liveError={error} />

  // While the file is still being uploaded there is nothing to delete yet.
  const settled = upload.stage === 'submitted' || upload.stage === 'error'
  const actions =
    upload.jobId && settled ? (
      <JobActions jobId={upload.jobId} canDownload={job?.status === 'done'} onDeleted={onRemove} />
    ) : upload.stage === 'rejected' ? (
      <button type="button" className={BUTTON} onClick={onRemove}>
        Dismiss
      </button>
    ) : null

  return (
    <Card name={upload.name} actions={actions}>
      {body}
      {job?.status === 'done' && upload.objectUrl && (
        <BeforeAfter before={upload.objectUrl} after={resultUrl} width={job.width} height={job.height} />
      )}
    </Card>
  )
}

/** A job from an earlier visit, followed live while it is still running. */
export function HistoryCard({ initial, onDeleted }: { initial: JobSummary; onDeleted: () => void }) {
  const { job, error } = useLiveJob(initial.id, initial)
  const current = job ?? initial
  return (
    <Card
      name={current.originalName}
      actions={<JobActions jobId={current.id} canDownload={current.status === 'done'} onDeleted={onDeleted} />}
    >
      <div className="flex items-center gap-3">
        <Thumbnail job={current} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <JobState job={current} liveError={error} />
        </div>
      </div>
    </Card>
  )
}

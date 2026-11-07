'use client'

import {
  type AccountKind,
  type FileType,
  fileFormats,
  formatBytes,
  type JobSummary,
  type JobSummaryStatus,
} from '@onetodone/compress-shared'
import Image from 'next/image'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'

import { useResultUrl } from '@/hooks/use-result-url'
import type { Upload } from '@/hooks/use-uploads'
import { api } from '@/lib/api'
import { ApiError, quotaLimitMessage } from '@/lib/api-error'
import { savedPercent } from '@/lib/files'

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

const ICON_BUTTON =
  'inline-flex size-8 items-center justify-center rounded-full border border-zinc-300 text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'

const DANGER_ICON_BUTTON = `${ICON_BUTTON} hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:border-red-900 dark:hover:bg-red-950 dark:hover:text-red-400`

function Icon({ d, spin = false }: { d: string; spin?: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`size-4 ${spin ? 'animate-spin' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  delete: 'M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  busy: 'M12 3a9 9 0 1 0 9 9',
}

/** Asks before a deletion, next to the button that opened it; Escape or a click outside cancels. */
function ConfirmDelete({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: (restoreFocus: boolean) => void }) {
  const textId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmButton.current?.focus()
    function onPointerDown(event: PointerEvent) {
      if (!panel.current?.contains(event.target as Node)) onCancel(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onCancel])

  return (
    <div
      ref={panel}
      role="alertdialog"
      aria-label="Delete file"
      aria-describedby={textId}
      className="absolute top-full right-0 z-10 mt-2 flex w-60 flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      <p id={textId} className="text-sm">
        Delete this file and its compressed version?
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={() => onCancel(true)}>
          Cancel
        </button>
        <button
          ref={confirmButton}
          type="button"
          className="rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
          onClick={onConfirm}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

/** Download (for finished jobs) and delete buttons, with the error of the last failed action. */
function JobActions({ jobId, canDownload, onDeleted }: { jobId: string; canDownload: boolean; onDeleted: () => void }) {
  const [busy, setBusy] = useState<'download' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)

  const cancelDelete = useCallback((restoreFocus: boolean) => {
    setConfirming(false)
    if (restoreFocus) deleteButton.current?.focus()
  }, [])

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

  const deleteLabel = busy === 'delete' ? 'Deleting…' : 'Delete'
  const downloadLabel = busy === 'download' ? 'Preparing…' : 'Download'

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="relative flex gap-2">
        <button
          ref={deleteButton}
          type="button"
          className={DANGER_ICON_BUTTON}
          title={deleteLabel}
          aria-label={deleteLabel}
          aria-haspopup="dialog"
          aria-expanded={confirming}
          disabled={busy !== null}
          onClick={() => setConfirming(true)}
        >
          <Icon d={busy === 'delete' ? ICONS.busy : ICONS.delete} spin={busy === 'delete'} />
        </button>
        {canDownload && (
          <button
            type="button"
            className={ICON_BUTTON}
            title={downloadLabel}
            aria-label={downloadLabel}
            disabled={busy !== null}
            onClick={() => void run('download')}
          >
            <Icon d={busy === 'download' ? ICONS.busy : ICONS.download} spin={busy === 'download'} />
          </button>
        )}
        {confirming && (
          <ConfirmDelete
            onCancel={cancelDelete}
            onConfirm={() => {
              setConfirming(false)
              void run('delete')
            }}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

/** Image formats that browsers other than Safari cannot display. */
const UNDISPLAYABLE_IMAGES: ReadonlySet<FileType> = new Set(['image/heic'])

/**
 * The format named on the icon shown instead of a picture: for documents, and for images browsers
 * cannot display unless the CDN made a preview. `null` for other images and unknown types.
 */
function iconFormatOf(job: JobSummary | null, name: string): string | null {
  const type = fileFormats.schema.safeParse(job?.outputType ?? job?.inputType ?? fileFormats.typeOfFileName(name))
  if (!type.success) return null
  const info = fileFormats.info(type.data)
  if (info.kind === 'document') return info.name
  return UNDISPLAYABLE_IMAGES.has(type.data) && !job?.previewUrl ? info.name : null
}

/**
 * Small picture of a job: for a finished image the CDN preview, or the result itself when there is
 * no preview; for a document, or an image browsers cannot display, an icon with its format.
 */
function Thumbnail({ job, name }: { job: JobSummary | null; name: string }) {
  const iconFormat = iconFormatOf(job, name)
  const done = job?.status === 'done' && iconFormat === null
  const resultUrl = useResultUrl(done && !job.previewUrl ? job.id : null)
  const src = done ? (job.previewUrl ?? resultUrl) : null
  return (
    <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      {src && <Image src={src} alt="" fill sizes="56px" className="object-cover" />}
      {iconFormat && (
        <>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-9"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinejoin="round"
          >
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v4h4" />
          </svg>
          <span className="absolute bottom-2.5 text-[9px] font-semibold tracking-wide">{iconFormat}</span>
        </>
      )}
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
  if (job.status === 'failed') return <Problem>{job.error ?? 'The file could not be compressed.'}</Problem>
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

function UploadState({ upload, accountKind }: { upload: Upload; accountKind: AccountKind }) {
  switch (upload.stage) {
    case 'rejected':
    case 'error':
      return <Problem>{upload.error}</Problem>
    case 'limited':
      return (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {quotaLimitMessage(upload.limit ?? 'daily_limit', accountKind)}
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
  accountKind: AccountKind
  /** Removes the card after the job was deleted or a refused file was dismissed. */
  onRemove: () => void
}

/** One file of the list: the upload while it runs, then the live job with its result. */
export function JobCard({ upload, job, liveStopped, accountKind, onRemove }: JobCardProps) {
  const name = job?.originalName ?? upload?.name ?? ''
  const jobId = job?.id ?? upload?.jobId ?? null
  // While the file is still being uploaded there is nothing to delete yet.
  const settled = !upload || upload.stage === 'submitted' || upload.stage === 'error'
  const dismissible = upload?.stage === 'rejected' || upload?.stage === 'limited'

  return (
    <article className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <Thumbnail job={job} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="min-w-0 truncate text-sm font-medium" title={name}>
          {name}
        </h3>
        {job && (!upload || upload.stage === 'submitted') ? (
          <JobState job={job} liveStopped={liveStopped} />
        ) : upload ? (
          <UploadState upload={upload} accountKind={accountKind} />
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

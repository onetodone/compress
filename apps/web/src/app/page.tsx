'use client'

import {
  type CompressionPreset,
  isTerminalJobStatus,
  type JobSummary,
  DEFAULT_COMPRESSION_PRESET,
  imageFormats,
} from '@onetodone/compress-shared'
import { useMemo, useState } from 'react'

import { AccountControl } from '@/components/account-control'
import { DropZone } from '@/components/drop-zone'
import { JobCard } from '@/components/job-card'
import { ListToolbar, type UploadTotals } from '@/components/list-toolbar'
import { PresetPicker } from '@/components/preset-picker'
import { QuotaMeter } from '@/components/quota-meter'
import { TelegramLoginNotice } from '@/components/telegram-login-notice'
import { type SessionUser, useAuthUser } from '@/hooks/use-auth-user'
import { useJobHistory } from '@/hooks/use-job-history'
import { type LiveJobEntry, useLiveJobs } from '@/hooks/use-live-jobs'
import { useQuota } from '@/hooks/use-quota'
import { type Upload, useUploads } from '@/hooks/use-uploads'
import { quotaLimitMessage } from '@/lib/api-error'

export default function HomePage() {
  const {
    user,
    error: authError,
    telegramLogin,
    signInWithGoogle,
    signOut,
    confirmTelegramLogin,
    dismissTelegramLogin,
  } = useAuthUser()

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10 sm:py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Compress OneToDone</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Smaller {imageFormats.names('and')} files, same look.
          </p>
        </div>
        {user && <AccountControl user={user} signInWithGoogle={signInWithGoogle} signOut={signOut} />}
      </header>

      {telegramLogin && (
        <TelegramLoginNotice
          state={telegramLogin}
          currentName={user?.name ?? null}
          onConfirm={confirmTelegramLogin}
          onDismiss={dismissTelegramLogin}
        />
      )}

      {authError ? (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {authError}
        </p>
      ) : user ? (
        // A different user gets a fresh workspace: no uploads, history or quota of the previous one.
        <Workspace key={user.uid} user={user} />
      ) : (
        <DropZone disabled hint="Starting a session…" maxInputBytes={null} onFiles={() => undefined} />
      )}
    </main>
  )
}

interface ListItem {
  key: string
  upload: Upload | null
  jobId: string | null
}

/** Whether an upload of this session has come to an end: refused, failed, or its job finished. */
function isFinished(upload: Upload, job: JobSummary | undefined): boolean {
  if (upload.stage === 'rejected' || upload.stage === 'limited' || upload.stage === 'error') return true
  return upload.stage === 'submitted' && job !== undefined && isTerminalJobStatus(job.status)
}

function uploadTotals(uploads: readonly Upload[], jobs: ReadonlyMap<string, JobSummary>): UploadTotals | null {
  if (uploads.length === 0) return null
  const totals = { total: uploads.length, done: 0, failed: 0, inputBytes: 0, outputBytes: 0 }
  for (const upload of uploads) {
    const job = upload.jobId ? jobs.get(upload.jobId) : undefined
    if (job?.status === 'done' && job.inputBytes !== null && job.outputBytes !== null) {
      totals.done++
      totals.inputBytes += job.inputBytes
      // A result that is not smaller is replaced by the original, so it saves nothing.
      totals.outputBytes += Math.min(job.outputBytes, job.inputBytes)
    } else if (isFinished(upload, job)) {
      totals.failed++
    }
  }
  return totals
}

function Workspace({ user }: { user: SessionUser }) {
  const { quota, limits, limitsFailed, networkLimitReached } = useQuota(user.uid, user.kind)
  const history = useJobHistory(user.uid)
  const { uploads, addFiles, removeUploads } = useUploads()
  const [preset, setPreset] = useState<CompressionPreset>(DEFAULT_COMPRESSION_PRESET)
  // Jobs cleared from the list stay hidden even when a later history page contains them.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())

  const earlierJobs = useMemo(() => {
    const sessionJobIds = new Set(uploads.flatMap((upload) => (upload.jobId ? [upload.jobId] : [])))
    return history.jobs.filter((job) => !sessionJobIds.has(job.id) && !hidden.has(job.id))
  }, [uploads, history.jobs, hidden])

  const entries = useMemo<LiveJobEntry[]>(
    () => [
      ...uploads.flatMap((upload) =>
        upload.stage === 'submitted' && upload.jobId ? [{ id: upload.jobId, initial: null }] : [],
      ),
      ...earlierJobs.map((job) => ({ id: job.id, initial: job })),
    ],
    [uploads, earlierJobs],
  )
  const live = useLiveJobs(entries)

  // A job removed on the server (stale, or deleted in another tab) leaves the list.
  const items: ListItem[] = [
    ...uploads.map((upload) => ({
      key: upload.key,
      upload,
      jobId: upload.stage === 'submitted' ? upload.jobId : null,
    })),
    ...earlierJobs.map((job) => ({ key: job.id, upload: null, jobId: job.id })),
  ].filter((item) => item.jobId === null || !live.removed.has(item.jobId))
  const downloadable = items.flatMap((item) => {
    const job = item.jobId ? live.jobs.get(item.jobId) : undefined
    return job?.status === 'done' ? [job] : []
  })
  const finishedKeys = new Set(
    uploads
      .filter((upload) => isFinished(upload, upload.jobId ? live.jobs.get(upload.jobId) : undefined))
      .map((upload) => upload.key),
  )

  function removeItem(item: ListItem) {
    if (item.upload) removeUploads(new Set([item.upload.key]))
    if (item.jobId) history.removeJob(item.jobId)
  }

  function clearFinished() {
    const jobIds = uploads.flatMap((upload) => (finishedKeys.has(upload.key) && upload.jobId ? [upload.jobId] : []))
    setHidden((current) => new Set([...current, ...jobIds]))
    removeUploads(finishedKeys)
  }

  const remaining = quota === null ? null : networkLimitReached ? 0 : Math.max(quota.limit - quota.used, 0)
  const limitHint =
    quota !== null && quota.used >= quota.limit
      ? quotaLimitMessage('daily_limit', user.kind)
      : networkLimitReached
        ? quotaLimitMessage('network_daily_limit', user.kind)
        : null
  const dropHint =
    limits === null ? (limitsFailed ? 'Could not load your limits. Retrying…' : 'Loading your limits…') : limitHint

  return (
    <>
      <section aria-label="Upload" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PresetPicker value={preset} disabled={dropHint !== null} onChange={setPreset} />
          {quota && <QuotaMeter quota={quota} exhausted={networkLimitReached} />}
        </div>
        <DropZone
          disabled={limits === null || limitHint !== null}
          hint={dropHint}
          maxInputBytes={limits?.maxInputBytes ?? null}
          onFiles={(files) => limits && addFiles(files, preset, remaining, limits.maxInputBytes)}
        />
      </section>

      <section aria-labelledby="images-heading" className="flex flex-col gap-3">
        <h2 id="images-heading" className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Your images
        </h2>
        <ListToolbar
          totals={uploadTotals(uploads, live.jobs)}
          downloadable={downloadable}
          finished={finishedKeys.size}
          onClearFinished={clearFinished}
        />
        {items.map((item) => (
          <JobCard
            key={item.key}
            upload={item.upload}
            job={(item.jobId && live.jobs.get(item.jobId)) || null}
            liveStopped={item.jobId !== null && live.stopped.has(item.jobId)}
            accountKind={user.kind}
            onRemove={() => removeItem(item)}
          />
        ))}
        {history.status === 'idle' && items.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Images you compress show up here.</p>
        )}
        {history.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {history.error}
          </p>
        )}
        {history.status === 'loading' && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>}
        {history.hasMore && history.status !== 'loading' && (
          <button
            type="button"
            onClick={history.loadMore}
            className="self-center rounded-full border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Load more
          </button>
        )}
      </section>
    </>
  )
}

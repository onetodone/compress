'use client'

import {
  type CompressionPreset,
  DEFAULT_COMPRESSION_PRESET,
  imageFormats,
  MAX_INPUT_BYTES,
} from '@onetodone/image-compressor-shared'
import { useState } from 'react'

import { AccountControl } from '@/components/account-control'
import { DropZone } from '@/components/drop-zone'
import { HistoryCard, UploadCard } from '@/components/job-cards'
import { PresetPicker } from '@/components/preset-picker'
import { QuotaMeter } from '@/components/quota-meter'
import { type SessionUser, useAuthUser } from '@/hooks/use-auth-user'
import { useJobHistory } from '@/hooks/use-job-history'
import { useQuota } from '@/hooks/use-quota'
import { useUploads } from '@/hooks/use-uploads'
import { formatBytes } from '@/lib/files'

export default function HomePage() {
  const { user, error: authError, signInWithGoogle, signOut } = useAuthUser()

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10 sm:py-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Image Compressor</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Smaller {imageFormats.names('and')} files, same look. Up to {formatBytes(MAX_INPUT_BYTES)} per image.
          </p>
        </div>
        {user && <AccountControl user={user} signInWithGoogle={signInWithGoogle} signOut={signOut} />}
      </header>

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
        <DropZone disabled hint="Starting a session…" onFiles={() => undefined} />
      )}
    </main>
  )
}

function Workspace({ user }: { user: SessionUser }) {
  const { quota, networkLimitReached } = useQuota(user.uid, user.isAnonymous)
  const history = useJobHistory(user.uid)
  const { uploads, addFiles, removeUpload } = useUploads()
  const [preset, setPreset] = useState<CompressionPreset>(DEFAULT_COMPRESSION_PRESET)

  const sessionJobIds = new Set(uploads.map((upload) => upload.jobId))
  const earlierJobs = history.jobs.filter((job) => !sessionJobIds.has(job.id))
  const limitHint =
    quota !== null && quota.used >= quota.limit
      ? user.isAnonymous
        ? 'Daily limit reached. Sign in for more, or try again tomorrow.'
        : 'Daily limit reached. Try again tomorrow.'
      : networkLimitReached
        ? 'Too many images from your network today. Sign in to continue.'
        : null

  return (
    <>
      <section aria-label="Upload" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PresetPicker value={preset} disabled={limitHint !== null} onChange={setPreset} />
          {quota && <QuotaMeter quota={quota} exhausted={networkLimitReached} />}
        </div>
        <DropZone disabled={limitHint !== null} hint={limitHint} onFiles={(files) => addFiles(files, preset)} />
      </section>

      {uploads.length > 0 && (
        <section aria-label="Uploads" className="flex flex-col gap-3">
          {uploads.map((upload) => (
            <UploadCard key={upload.key} upload={upload} onRemove={() => removeUpload(upload.key)} />
          ))}
        </section>
      )}

      <section aria-labelledby="history-heading" className="flex flex-col gap-3">
        <h2 id="history-heading" className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          Your images
        </h2>
        {earlierJobs.map((job) => (
          <HistoryCard key={job.id} initial={job} onDeleted={() => history.removeJob(job.id)} />
        ))}
        {history.status === 'idle' && earlierJobs.length === 0 && uploads.length === 0 && (
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

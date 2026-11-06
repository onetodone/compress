'use client'

import type { CompressionPreset, QuotaErrorCode } from '@onetodone/image-compressor-shared'
import { useCallback, useState } from 'react'

import { api } from '@/lib/api'
import { checkFile } from '@/lib/files'
import { uploadFile } from '@/lib/upload'
import { type QueuedPatch, type QueuedStage, UploadQueue } from '@/lib/upload-queue'

/** A file picked in this session, from the client-side check until the job is queued. */
export interface Upload {
  key: string
  name: string
  size: number
  /** `rejected` failed the client-side check; the other stages come from the upload queue. */
  stage: 'rejected' | QueuedStage
  /** Uploaded fraction from 0 to 1. */
  progress: number
  jobId: string | null
  /** User-safe reason of a `rejected` or `error` upload. */
  error: string | null
  /** The limit that refused a `limited` upload. */
  limit: QuotaErrorCode | null
}

/**
 * Uploads picked in this session, the latest pick first and the files of each pick in their order,
 * and functions that start more or drop some.
 */
export interface Uploads {
  uploads: Upload[]
  /**
   * Starts uploads of picked files, compressed with `preset`.
   * @param remaining jobs the user may still submit today, if known; files beyond it are marked as limited
   * @param maxInputBytes largest file the user may upload; larger files are rejected
   */
  addFiles: (files: Iterable<File>, preset: CompressionPreset, remaining: number | null, maxInputBytes: number) => void
  /** Drops uploads from the list. */
  removeUploads: (keys: ReadonlySet<string>) => void
}

/** Runs the upload flow for each picked file through an {@link UploadQueue}. */
export function useUploads(): Uploads {
  const [uploads, setUploads] = useState<Upload[]>([])

  const update = useCallback((key: string, patch: QueuedPatch) => {
    setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload)))
  }, [])

  const [queue] = useState(
    () =>
      new UploadQueue(
        {
          create: (request) => api.createJob(request),
          upload: uploadFile,
          submit: (jobId) => api.submitJob(jobId),
          discard: (jobId) => api.deleteJob(jobId),
        },
        update,
      ),
  )

  const addFiles = useCallback(
    (files: Iterable<File>, preset: CompressionPreset, remaining: number | null, maxInputBytes: number) => {
      // Files already on their way are not counted in the quota yet.
      let allowance = remaining === null ? Infinity : remaining - queue.pending
      const added: Upload[] = []
      const accepted: [string, File, Parameters<UploadQueue['add']>[2]][] = []
      for (const file of files) {
        const key = crypto.randomUUID()
        const base = { key, name: file.name, size: file.size, progress: 0, jobId: null, error: null, limit: null }
        const checked = checkFile(file, maxInputBytes, preset)
        if (!checked.ok) {
          added.push({ ...base, stage: 'rejected', error: checked.reason })
        } else if (allowance <= 0) {
          added.push({ ...base, stage: 'limited', limit: 'daily_limit' })
        } else {
          allowance--
          added.push({ ...base, stage: 'waiting' })
          accepted.push([key, file, checked.request])
        }
      }
      setUploads((current) => [...added, ...current])
      for (const [key, file, request] of accepted) queue.add(key, file, request)
    },
    [queue],
  )

  const removeUploads = useCallback((keys: ReadonlySet<string>) => {
    setUploads((current) => current.filter((upload) => !keys.has(upload.key)))
  }, [])

  return { uploads, addFiles, removeUploads }
}

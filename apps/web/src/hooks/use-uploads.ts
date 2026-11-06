'use client'

import type { CompressionPreset } from '@onetodone/image-compressor-shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '@/lib/api'
import { ApiError } from '@/lib/api-error'
import { checkFile } from '@/lib/files'
import { UploadError, uploadFile } from '@/lib/upload'

/** A file picked in this session, from the client-side check until the job is queued. */
export interface Upload {
  key: string
  name: string
  size: number
  /** Object URL of the original, for the before/after view; `null` for rejected files. */
  objectUrl: string | null
  stage: 'rejected' | 'creating' | 'uploading' | 'submitting' | 'submitted' | 'error'
  /** Uploaded fraction from 0 to 1. */
  progress: number
  jobId: string | null
  error: string | null
}

/** Uploads picked in this session, newest first, and functions that start more or drop one. */
export interface Uploads {
  uploads: Upload[]
  /** Starts uploads of picked files, compressed with `preset`. */
  addFiles: (files: Iterable<File>, preset: CompressionPreset) => void
  /** Drops an upload from the list and releases its object URL. */
  removeUpload: (key: string) => void
}

/** Runs the upload flow for each picked file: create the job, upload to R2, submit. */
export function useUploads(): Uploads {
  const [uploads, setUploads] = useState<Upload[]>([])
  const objectUrls = useRef(new Set<string>())

  useEffect(() => {
    const urls = objectUrls.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  const update = useCallback((key: string, patch: Partial<Upload>) => {
    setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload)))
  }, [])

  const run = useCallback(
    async (key: string, file: File, request: Parameters<typeof api.createJob>[0]) => {
      try {
        const { jobId, uploadUrl } = await api.createJob(request)
        update(key, { stage: 'uploading', jobId })
        await uploadFile(uploadUrl, file, request.contentType, (progress) => update(key, { progress }))
        update(key, { stage: 'submitting', progress: 1 })
        await api.submitJob(jobId)
        update(key, { stage: 'submitted' })
      } catch (error) {
        const message =
          error instanceof ApiError || error instanceof UploadError ? error.message : 'Something went wrong. Try again.'
        update(key, { stage: 'error', error: message })
      }
    },
    [update],
  )

  const addFiles = useCallback(
    (files: Iterable<File>, preset: CompressionPreset) => {
      const added: Upload[] = []
      for (const file of files) {
        const key = crypto.randomUUID()
        const checked = checkFile(file, preset)
        const base = { key, name: file.name, size: file.size, progress: 0, jobId: null }
        if (!checked.ok) {
          added.push({ ...base, objectUrl: null, stage: 'rejected', error: checked.reason })
          continue
        }
        const objectUrl = URL.createObjectURL(file)
        objectUrls.current.add(objectUrl)
        added.push({ ...base, objectUrl, stage: 'creating', error: null })
        void run(key, file, checked.request)
      }
      setUploads((current) => [...added.reverse(), ...current])
    },
    [run],
  )

  const removeUpload = useCallback((key: string) => {
    setUploads((current) => {
      const objectUrl = current.find((upload) => upload.key === key)?.objectUrl
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrls.current.delete(objectUrl)
      }
      return current.filter((upload) => upload.key !== key)
    })
  }, [])

  return { uploads, addFiles, removeUpload }
}

'use client'

import { imageFormats, MAX_INPUT_BYTES } from '@onetodone/image-compressor-shared'
import { type DragEvent, useState } from 'react'

import { formatBytes } from '@/lib/files'

interface DropZoneProps {
  disabled: boolean
  /** Shown instead of the instructions, e.g. why the zone is disabled. */
  hint: string | null
  onFiles: (files: File[]) => void
}

export function DropZone({ disabled, hint, onFiles }: DropZoneProps) {
  const [dragging, setDragging] = useState(false)

  const onDragOver = (event: DragEvent) => {
    event.preventDefault()
    if (!disabled) setDragging(true)
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (!disabled && event.dataTransfer.files.length > 0) onFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <label
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      aria-disabled={disabled}
      className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
        disabled
          ? 'cursor-not-allowed border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600'
          : dragging
            ? 'cursor-copy border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
            : 'cursor-pointer border-zinc-300 hover:border-zinc-400 hover:bg-white dark:border-zinc-700 dark:hover:border-zinc-500 dark:hover:bg-zinc-900'
      }`}
    >
      <input
        type="file"
        accept={imageFormats.accept}
        multiple
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
      <svg aria-hidden viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
        />
      </svg>
      {hint ? (
        <span className="text-sm">{hint}</span>
      ) : (
        <>
          <span className="font-medium">Drop images here or click to choose</span>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {imageFormats.names('or')}, up to {formatBytes(MAX_INPUT_BYTES)} each
          </span>
        </>
      )}
    </label>
  )
}

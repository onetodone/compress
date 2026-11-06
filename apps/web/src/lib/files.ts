import {
  type CompressionPreset,
  type CreateJobRequest,
  createJobRequestSchema,
  DEFAULT_COMPRESSION_PRESET,
  downloadFileName,
  imageFormats,
  type ImageType,
  formatBytes,
  type JobSummary,
} from '@onetodone/image-compressor-shared'

/** A file the user picked, either accepted for upload or rejected with a reason. */
export type CheckedFile = { ok: true; request: CreateJobRequest } | { ok: false; reason: string }

/**
 * Returns the image type of a picked file. Browsers report an empty type for extensions the operating
 * system does not know (e.g. `.avif` on some systems), so the extension decides then.
 * @param file file metadata as the browser reports it
 */
export function imageTypeOf(file: Pick<File, 'name' | 'type'>): ImageType | undefined {
  if (file.type !== '') {
    const declared = imageFormats.schema.safeParse(file.type)
    return declared.success ? declared.data : undefined
  }
  const dot = file.name.lastIndexOf('.')
  return dot > 0 ? imageFormats.typeOfExtension(file.name.slice(dot + 1)) : undefined
}

/**
 * Checks a picked file against the limits of `POST /jobs` before anything is uploaded.
 * @param file file metadata as the browser reports it
 * @param maxInputBytes largest file the user may upload, from `GET /me`
 * @param preset compression preset the job is created with
 */
export function checkFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  maxInputBytes: number,
  preset: CompressionPreset = DEFAULT_COMPRESSION_PRESET,
): CheckedFile {
  const contentType = imageTypeOf(file)
  if (!contentType) return { ok: false, reason: `Only ${imageFormats.names('and')}` }
  if (file.size === 0) return { ok: false, reason: 'The file is empty' }
  if (file.size > maxInputBytes) return { ok: false, reason: `Larger than ${formatBytes(maxInputBytes)}` }
  const result = createJobRequestSchema.safeParse({
    originalName: file.name,
    contentType,
    size: file.size,
    settings: { preset },
  })
  return result.success ? { ok: true, request: result.data } : { ok: false, reason: 'Unsupported file name' }
}

/**
 * Returns the share of the original size saved by compression, as a whole percentage.
 * @param inputBytes size of the original
 * @param outputBytes size of the result
 */
export function savedPercent(inputBytes: number, outputBytes: number): number {
  if (inputBytes <= 0 || outputBytes >= inputBytes) return 0
  return Math.round(((inputBytes - outputBytes) / inputBytes) * 100)
}

/**
 * Returns the name the result of a finished job is saved under, the same one `GET /jobs/:id/download`
 * gives it. A result type this version does not know keeps the original name.
 * @param job finished job
 */
export function resultFileName(job: Pick<JobSummary, 'originalName' | 'inputType' | 'outputType'>): string {
  const type = imageFormats.schema.safeParse(job.outputType ?? job.inputType)
  return type.success ? downloadFileName(job.originalName, type.data) : job.originalName
}

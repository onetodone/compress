import {
  type CompressionPreset,
  type CreateJobRequest,
  createJobRequestSchema,
  DEFAULT_COMPRESSION_PRESET,
  downloadFileName,
  fileFormats,
  type FileType,
  formatBytes,
  type InputLimits,
  type JobSummary,
} from '@onetodone/compress-shared'

/** A file the user picked, either accepted for upload or rejected with a reason. */
export type CheckedFile = { ok: true; request: CreateJobRequest } | { ok: false; reason: string }

/**
 * Returns the file type of a picked file. Browsers report an empty type for extensions the operating
 * system does not know (e.g. `.avif` on some systems), so the extension decides then.
 * @param file file metadata as the browser reports it
 */
export function fileTypeOf(file: Pick<File, 'name' | 'type'>): FileType | undefined {
  if (file.type !== '') return fileFormats.typeOfMimeType(file.type)
  return fileFormats.typeOfFileName(file.name)
}

/**
 * Checks a picked file against the limits of `POST /jobs` before anything is uploaded.
 * @param file file metadata as the browser reports it
 * @param limits file types the user may upload and their size limits, from `GET /me`
 * @param preset compression preset the job is created with
 */
export function checkFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  limits: InputLimits,
  preset: CompressionPreset = DEFAULT_COMPRESSION_PRESET,
): CheckedFile {
  const contentType = fileTypeOf(file)
  const maxBytes = contentType && limits[contentType]
  if (!contentType || maxBytes === undefined) {
    const accepted = fileFormats.types.filter((type) => limits[type] !== undefined)
    return { ok: false, reason: `Only ${fileFormats.names('and', accepted)}` }
  }
  if (file.size === 0) return { ok: false, reason: 'The file is empty' }
  if (file.size > maxBytes) return { ok: false, reason: `Larger than ${formatBytes(maxBytes)}` }
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
  const type = fileFormats.schema.safeParse(job.outputType ?? job.inputType)
  return type.success ? downloadFileName(job.originalName, type.data) : job.originalName
}

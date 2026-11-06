import { z } from 'zod'

import { IMAGE_TYPES, type ImageType, imageTypeSchema } from './format.js'

/** Lifecycle states of a compression job, in the order a successful job passes through them. */
export const JOB_STATUSES = ['awaiting_upload', 'queued', 'processing', 'done', 'failed'] as const

/** Validates a job status value. */
export const jobStatusSchema = z.enum(JOB_STATUSES)

/** Lifecycle state of a compression job. */
export type JobStatus = z.infer<typeof jobStatusSchema>

/** Statuses after which a job never changes again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['done', 'failed']

/**
 * Whether a job in this status never changes again. Accepts any string, so a status this version
 * does not know counts as still running.
 * @param status status as read from a job
 */
export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)
}

/** Image MIME types accepted for compression: every supported format. */
export const INPUT_TYPES = IMAGE_TYPES

/** Validates an accepted image MIME type. */
export const inputTypeSchema = imageTypeSchema

/** Image MIME type accepted for compression. */
export type InputType = ImageType

/** Trade-offs between quality and size offered for compression. */
export const COMPRESSION_PRESETS = ['balanced', 'smaller'] as const

/** Validates a compression preset. */
export const compressionPresetSchema = z.enum(COMPRESSION_PRESETS)

/** Trade-off between quality and size: `balanced` keeps the look, `smaller` gives up some quality for size. */
export type CompressionPreset = z.infer<typeof compressionPresetSchema>

/** Preset used when a job does not name one. */
export const DEFAULT_COMPRESSION_PRESET: CompressionPreset = 'balanced'

/** Validates the compression settings of a job, filling in defaults. */
export const jobSettingsSchema = z.object({
  preset: compressionPresetSchema.default(DEFAULT_COMPRESSION_PRESET),
})

/** Compression settings of a job, stored as `settings` on the job document. */
export type JobSettings = z.infer<typeof jobSettingsSchema>

const storedJobSettingsSchema = z
  .object({ preset: compressionPresetSchema.catch(DEFAULT_COMPRESSION_PRESET) })
  .catch({ preset: DEFAULT_COMPRESSION_PRESET })

/**
 * Reads the stored `settings` of a job. Documents without settings, and values this version does
 * not know, read as the defaults.
 * @param value the `settings` field of a job document
 */
export function readJobSettings(value: unknown): JobSettings {
  return storedJobSettingsSchema.parse(value ?? {})
}

/**
 * Largest original image the API accepts from anyone, in bytes (10 MB). The limit of a user can be
 * lower; `GET /me` returns it as `limits.maxInputBytes`.
 */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024

/** How long a presigned upload URL stays valid, in seconds (10 minutes). */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60

/** How long a presigned download URL stays valid, in seconds (5 minutes). */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60

/** Validates a job id: a Firestore auto-generated document id. */
export const jobIdSchema = z.string().regex(/^[A-Za-z0-9]{20}$/)

/** Validates the body of `POST /jobs`, which describes the file the client is about to upload. */
export const createJobRequestSchema = z.object({
  /** File name shown to the user and used for downloads. */
  originalName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f/\\]+$/, 'Must not contain control characters or path separators'),
  /** MIME type the upload will be sent with. */
  contentType: inputTypeSchema,
  /** Exact size of the upload in bytes. */
  size: z.number().int().positive().max(MAX_INPUT_BYTES),
  /** How to compress the image; defaults apply to anything left out. */
  settings: jobSettingsSchema.prefault({}),
})

/** Body of `POST /jobs` after validation, with defaults filled in. */
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>

/** Validates the response of `POST /jobs`. */
export const createJobResponseSchema = z.object({
  jobId: jobIdSchema,
  /**
   * Presigned URL for a `PUT` of the file. The request must send the declared `Content-Type`,
   * and the body must be exactly the declared size.
   */
  uploadUrl: z.url(),
  /** ISO timestamp after which `uploadUrl` no longer works. */
  uploadExpiresAt: z.iso.datetime(),
})

/** Response of `POST /jobs`. */
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>

/**
 * Statuses a client can show. `unknown` stands for a status this version does not know, so an older
 * client keeps working when a status is added.
 */
export const jobSummaryStatusSchema = z.enum([...JOB_STATUSES, 'unknown']).catch('unknown')

/** Status of a job as a client sees it. */
export type JobSummaryStatus = z.infer<typeof jobSummaryStatusSchema>

/** Validates the response of `POST /jobs/:id/submit`. */
export const submitJobResponseSchema = z.object({
  jobId: jobIdSchema,
  status: jobSummaryStatusSchema,
})

/** Response of `POST /jobs/:id/submit`: the job and its status after the submit. */
export type SubmitJobResponse = z.infer<typeof submitJobResponseSchema>

/** Validates the query of `GET /jobs/:id/download`. */
export const downloadJobQuerySchema = z.object({
  /** `attachment` saves the file; `inline` lets the browser display it, e.g. in an `<img>`. */
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
})

/** Query of `GET /jobs/:id/download`. */
export type DownloadJobQuery = z.infer<typeof downloadJobQuerySchema>

/** Validates the response of `GET /jobs/:id/download`. */
export const downloadJobResponseSchema = z.object({
  /** Presigned URL of the compressed file, named after the original. */
  url: z.url(),
  /** ISO timestamp after which `url` no longer works. */
  expiresAt: z.iso.datetime(),
})

/** Response of `GET /jobs/:id/download`. */
export type DownloadJobResponse = z.infer<typeof downloadJobResponseSchema>

/**
 * Validates a job as shown to its owner. Storage keys and internal bookkeeping are left out. Fields
 * this version does not know are dropped, and types and statuses it does not know are kept or read
 * as `unknown`, so an open page of an older web build still reads newer jobs.
 */
export const jobSummarySchema = z.object({
  id: jobIdSchema,
  status: jobSummaryStatusSchema,
  originalName: z.string(),
  /** MIME type; the declared one until the worker detects the real one. May name a format this version does not know. */
  inputType: z.string(),
  /** MIME type of the result, once the job is done. */
  outputType: z.string().nullable(),
  inputBytes: z.number().int().nonnegative().nullable(),
  outputBytes: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  previewUrl: z.url().nullable(),
  /** User-safe reason of a failed job. */
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
})

/** A job as shown to its owner. */
export type JobSummary = z.infer<typeof jobSummarySchema>

/** A Firestore timestamp from either the Admin or the client SDK. */
export interface TimestampLike {
  toDate(): Date
}

/**
 * Builds the owner's view of a `jobs/{jobId}` document. Works with data from the Admin and the client
 * SDK, and treats fields missing from older documents as empty. Returns `null` for a document that
 * cannot be shown, e.g. one without a name or creation time.
 * @param id document id
 * @param data document data
 */
export function toJobSummary(id: string, data: Record<string, unknown>): JobSummary | null {
  const iso = (value: unknown) => (isTimestamp(value) ? value.toDate().toISOString() : null)
  const orNull = (value: unknown) => value ?? null
  const result = jobSummarySchema.safeParse({
    id,
    status: data.status,
    originalName: data.originalName,
    inputType: data.inputType,
    outputType: orNull(data.outputType),
    inputBytes: orNull(data.inputBytes),
    outputBytes: orNull(data.outputBytes),
    width: orNull(data.width),
    height: orNull(data.height),
    previewUrl: orNull(data.previewUrl),
    error: orNull(data.error),
    createdAt: iso(data.createdAt),
    finishedAt: iso(data.finishedAt),
  })
  return result.success ? result.data : null
}

function isTimestamp(value: unknown): value is TimestampLike {
  return typeof value === 'object' && value !== null && typeof (value as TimestampLike).toDate === 'function'
}

/** Default number of jobs per page of `GET /jobs`. */
export const JOBS_PAGE_SIZE = 20

/** Largest number of jobs per page of `GET /jobs`. */
export const MAX_JOBS_PAGE_SIZE = 50

/** Validates the query of `GET /jobs`. */
export const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_JOBS_PAGE_SIZE).default(JOBS_PAGE_SIZE),
  /** Opaque `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
})

/** Query of `GET /jobs`. */
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>

/** Validates the response of `GET /jobs`. */
export const listJobsResponseSchema = z.object({
  /** The user's jobs, newest first. A job this version cannot read is left out instead of failing the page. */
  jobs: z.array(z.unknown()).transform((jobs) =>
    jobs.flatMap((job) => {
      const result = jobSummarySchema.safeParse(job)
      return result.success ? [result.data] : []
    }),
  ),
  /** Cursor of the next page, or `null` on the last page. */
  nextCursor: z.string().nullable(),
})

/** Response of `GET /jobs`: one page of the user's jobs. */
export type ListJobsResponse = z.infer<typeof listJobsResponseSchema>

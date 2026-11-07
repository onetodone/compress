import { describe, expect, it } from 'vitest'

import {
  createJobRequestSchema,
  inputTypeSchema,
  isTerminalJobStatus,
  jobIdSchema,
  jobStatusSchema,
  listJobsQuerySchema,
  listJobsResponseSchema,
  readJobSettings,
  submitJobResponseSchema,
  toJobSummary,
} from './job.js'
import { MAX_INPUT_BYTES } from './format.js'

describe('jobStatusSchema', () => {
  it('accepts every known status', () => {
    for (const status of ['awaiting_upload', 'queued', 'processing', 'done', 'failed']) {
      expect(jobStatusSchema.parse(status)).toBe(status)
    }
  })

  it('rejects an unknown status', () => {
    expect(jobStatusSchema.safeParse('cancelled').success).toBe(false)
  })
})

describe('isTerminalJobStatus', () => {
  it('treats done and failed as final and anything else as running', () => {
    expect(isTerminalJobStatus('done')).toBe(true)
    expect(isTerminalJobStatus('failed')).toBe(true)
    expect(isTerminalJobStatus('queued')).toBe(false)
    expect(isTerminalJobStatus('unknown')).toBe(false)
  })
})

describe('inputTypeSchema', () => {
  it('accepts JPEG, PNG, WebP, AVIF and PDF', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']) {
      expect(inputTypeSchema.parse(type)).toBe(type)
    }
  })

  it('rejects other types', () => {
    expect(inputTypeSchema.safeParse('image/gif').success).toBe(false)
    expect(inputTypeSchema.safeParse('application/zip').success).toBe(false)
    expect(inputTypeSchema.safeParse('image/heic').success).toBe(false)
  })
})

describe('readJobSettings', () => {
  it('reads stored settings', () => {
    expect(readJobSettings({ preset: 'smaller' })).toEqual({ preset: 'smaller' })
  })

  it('reads missing or unknown settings as the defaults', () => {
    expect(readJobSettings(undefined)).toEqual({ preset: 'balanced' })
    expect(readJobSettings(null)).toEqual({ preset: 'balanced' })
    expect(readJobSettings({ preset: 'tiny' })).toEqual({ preset: 'balanced' })
    expect(readJobSettings('smaller')).toEqual({ preset: 'balanced' })
  })
})

describe('createJobRequestSchema', () => {
  const valid = { originalName: 'photo.jpg', contentType: 'image/jpeg', size: 1024 }

  it('accepts a supported file within the size limit with the default settings', () => {
    expect(createJobRequestSchema.parse(valid)).toEqual({ ...valid, settings: { preset: 'balanced' } })
    expect(createJobRequestSchema.parse({ ...valid, contentType: 'image/avif' }).contentType).toBe('image/avif')
    expect(createJobRequestSchema.parse({ ...valid, contentType: 'application/pdf', size: MAX_INPUT_BYTES }).size).toBe(
      MAX_INPUT_BYTES,
    )
  })

  it('trims the file name', () => {
    expect(createJobRequestSchema.parse({ ...valid, originalName: '  photo.jpg ' }).originalName).toBe('photo.jpg')
  })

  it('rejects files over 20 MB and empty files', () => {
    expect(createJobRequestSchema.safeParse({ ...valid, size: MAX_INPUT_BYTES + 1 }).success).toBe(false)
    expect(createJobRequestSchema.safeParse({ ...valid, size: 0 }).success).toBe(false)
  })

  it('takes a compression preset and fills in the rest of the settings', () => {
    expect(createJobRequestSchema.parse({ ...valid, settings: { preset: 'smaller' } }).settings).toEqual({
      preset: 'smaller',
    })
    expect(createJobRequestSchema.parse({ ...valid, settings: {} }).settings).toEqual({ preset: 'balanced' })
  })

  it('rejects unknown presets', () => {
    expect(createJobRequestSchema.safeParse({ ...valid, settings: { preset: 'tiny' } }).success).toBe(false)
  })

  it('rejects unsupported content types', () => {
    expect(createJobRequestSchema.safeParse({ ...valid, contentType: 'image/gif' }).success).toBe(false)
  })

  it('rejects file names with path separators or control characters', () => {
    for (const originalName of ['', '   ', '../photo.jpg', 'dir\\photo.jpg', 'photo\n.jpg', 'a'.repeat(256)]) {
      expect(createJobRequestSchema.safeParse({ ...valid, originalName }).success).toBe(false)
    }
  })
})

describe('jobIdSchema', () => {
  it('accepts a Firestore auto id', () => {
    expect(jobIdSchema.safeParse('a1B2c3D4e5F6g7H8i9J0').success).toBe(true)
  })

  it('rejects ids that could address another document path', () => {
    for (const id of ['short', 'a1B2c3D4e5F6g7H8i9J/', '../users/a1B2c3D4e5F']) {
      expect(jobIdSchema.safeParse(id).success).toBe(false)
    }
  })
})

describe('toJobSummary', () => {
  const timestamp = (iso: string) => ({ toDate: () => new Date(iso) })
  const id = 'a1B2c3D4e5F6g7H8i9J0'

  it('maps a finished job and leaves storage details out', () => {
    const summary = toJobSummary(id, {
      ownerId: 'uid',
      status: 'done',
      originalName: 'photo.jpg',
      inputType: 'image/jpeg',
      inputKey: 'originals/uid/id',
      inputBytes: 2048,
      outputKey: 'results/uid/id.jpg',
      outputBytes: 512,
      width: 64,
      height: 48,
      previewUrl: null,
      error: null,
      createdAt: timestamp('2026-10-21T10:00:00.000Z'),
      finishedAt: timestamp('2026-10-21T10:00:05.000Z'),
    })

    expect(summary).toEqual({
      id,
      status: 'done',
      originalName: 'photo.jpg',
      inputType: 'image/jpeg',
      outputType: null,
      inputBytes: 2048,
      outputBytes: 512,
      width: 64,
      height: 48,
      previewUrl: null,
      error: null,
      createdAt: '2026-10-21T10:00:00.000Z',
      finishedAt: '2026-10-21T10:00:05.000Z',
    })
  })

  it('treats fields missing from older documents as empty', () => {
    const summary = toJobSummary(id, {
      status: 'queued',
      originalName: 'graphic.png',
      inputType: 'image/png',
      createdAt: timestamp('2026-10-21T10:00:00.000Z'),
    })

    expect(summary).toMatchObject({
      outputType: null,
      inputBytes: null,
      outputBytes: null,
      previewUrl: null,
      finishedAt: null,
    })
  })

  it('keeps types and statuses this version does not know, and drops unknown fields', () => {
    const summary = toJobSummary(id, {
      status: 'cancelled',
      originalName: 'drawing.jxl',
      inputType: 'image/jxl',
      outputType: 'image/jxl',
      createdAt: timestamp('2026-10-21T10:00:00.000Z'),
      settings: { preset: 'tiny' },
    })

    expect(summary).toMatchObject({ status: 'unknown', inputType: 'image/jxl', outputType: 'image/jxl' })
    expect(summary).not.toHaveProperty('settings')
  })

  it('returns null for a document that cannot be shown', () => {
    expect(toJobSummary(id, { status: 'done', inputType: 'image/png' })).toBeNull()
  })
})

describe('listJobsResponseSchema', () => {
  const job = {
    id: 'a1B2c3D4e5F6g7H8i9J0',
    status: 'done',
    originalName: 'photo.webp',
    inputType: 'image/webp',
    outputType: 'image/webp',
    inputBytes: 2048,
    outputBytes: 512,
    width: 64,
    height: 48,
    previewUrl: null,
    error: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    finishedAt: '2026-10-21T10:00:05.000Z',
  }

  it('reads jobs with unknown statuses, types and fields', () => {
    const page = listJobsResponseSchema.parse({
      jobs: [{ ...job, status: 'archived', inputType: 'image/jxl', outputType: 'image/jxl', tags: ['a'] }],
      nextCursor: null,
    })

    expect(page.jobs).toEqual([{ ...job, status: 'unknown', inputType: 'image/jxl', outputType: 'image/jxl' }])
  })

  it('leaves out a job it cannot read instead of failing the page', () => {
    const page = listJobsResponseSchema.parse({ jobs: [{ id: 'broken' }, job], nextCursor: 'next' })

    expect(page).toEqual({ jobs: [job], nextCursor: 'next' })
  })
})

describe('submitJobResponseSchema', () => {
  it('reads a status this version does not know as unknown', () => {
    expect(submitJobResponseSchema.parse({ jobId: 'a1B2c3D4e5F6g7H8i9J0', status: 'scheduled' }).status).toBe('unknown')
  })
})

describe('listJobsQuerySchema', () => {
  it('uses the default page size and coerces a limit from the query string', () => {
    expect(listJobsQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(listJobsQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({ limit: 5, cursor: 'abc' })
  })

  it('rejects page sizes outside 1 to 50', () => {
    for (const limit of ['0', '51', 'ten']) {
      expect(listJobsQuerySchema.safeParse({ limit }).success).toBe(false)
    }
  })
})

import type { InputLimits } from '@onetodone/compress-shared'
import { describe, expect, it } from 'vitest'

import { checkFile, resultFileName, savedPercent } from './files'

const MB = 1024 * 1024
const LIMIT = 10 * MB
const IMAGES: InputLimits = { 'image/jpeg': LIMIT, 'image/png': LIMIT, 'image/webp': LIMIT, 'image/avif': LIMIT }
const LIMITS: InputLimits = { ...IMAGES, 'application/pdf': 20 * MB }

describe('checkFile', () => {
  it('accepts a supported file within the size limit', () => {
    expect(checkFile({ name: 'photo.jpg', type: 'image/jpeg', size: 2048 }, LIMITS)).toEqual({
      ok: true,
      request: { originalName: 'photo.jpg', contentType: 'image/jpeg', size: 2048, settings: { preset: 'balanced' } },
    })
    expect(checkFile({ name: 'graphic.png', type: 'image/png', size: LIMIT }, LIMITS).ok).toBe(true)
    expect(checkFile({ name: 'sticker.webp', type: 'image/webp', size: 10 }, LIMITS).ok).toBe(true)
    expect(checkFile({ name: 'render.avif', type: 'image/avif', size: 10 }, LIMITS).ok).toBe(true)
    expect(checkFile({ name: 'report.pdf', type: 'application/pdf', size: 20 * MB }, LIMITS).ok).toBe(true)
  })

  it('creates the job with the chosen preset', () => {
    const checked = checkFile({ name: 'photo.jpg', type: 'image/jpeg', size: 2048 }, LIMITS, 'smaller')

    expect(checked.ok && checked.request.settings).toEqual({ preset: 'smaller' })
  })

  it('takes the type from the extension when the browser reports none', () => {
    const checked = checkFile({ name: 'render.AVIF', type: '', size: 10 }, LIMITS)

    expect(checked.ok && checked.request.contentType).toBe('image/avif')
    expect(checkFile({ name: 'notes.txt', type: '', size: 10 }, LIMITS).ok).toBe(false)
  })

  it('rejects other types, empty files and files over the limit', () => {
    expect(checkFile({ name: 'a.gif', type: 'image/gif', size: 10 }, LIMITS)).toEqual({
      ok: false,
      reason: 'Only JPEG, PNG, WebP, AVIF and PDF',
    })
    expect(checkFile({ name: 'a.png', type: 'image/gif', size: 10 }, LIMITS).ok).toBe(false)
    expect(checkFile({ name: 'a.png', type: 'image/png', size: 0 }, LIMITS)).toEqual({
      ok: false,
      reason: 'The file is empty',
    })
    expect(checkFile({ name: 'a.png', type: 'image/png', size: LIMIT + 1 }, LIMITS)).toEqual({
      ok: false,
      reason: 'Larger than 10 MB',
    })
    expect(checkFile({ name: 'a.pdf', type: 'application/pdf', size: 20 * MB + 1 }, LIMITS)).toEqual({
      ok: false,
      reason: 'Larger than 20 MB',
    })
  })

  it('rejects PDF files when the user may not upload them', () => {
    expect(checkFile({ name: 'report.pdf', type: 'application/pdf', size: 10 }, IMAGES)).toEqual({
      ok: false,
      reason: 'Only JPEG, PNG, WebP and AVIF',
    })
  })

  it("checks the size against the user's limit", () => {
    const limit = 5 * MB

    expect(checkFile({ name: 'a.png', type: 'image/png', size: limit }, { 'image/png': limit }).ok).toBe(true)
    expect(checkFile({ name: 'a.png', type: 'image/png', size: limit + 1 }, { 'image/png': limit })).toEqual({
      ok: false,
      reason: 'Larger than 5.0 MB',
    })
  })

  it('rejects a name the API would refuse', () => {
    expect(checkFile({ name: 'a'.repeat(300), type: 'image/png', size: 10 }, LIMITS).ok).toBe(false)
  })
})

describe('savedPercent', () => {
  it('returns the saved share of the original', () => {
    expect(savedPercent(19_879, 3_313)).toBe(83)
  })

  it('returns zero when nothing was saved', () => {
    expect(savedPercent(1000, 1000)).toBe(0)
    expect(savedPercent(0, 0)).toBe(0)
  })
})

describe('resultFileName', () => {
  it('names the result after the original with the extension of the result type', () => {
    expect(resultFileName({ originalName: 'Report.PDF', inputType: 'application/pdf', outputType: null })).toBe(
      'Report.pdf',
    )
    expect(resultFileName({ originalName: 'scan.jpg', inputType: 'image/jpeg', outputType: 'image/png' })).toBe(
      'scan.png',
    )
    expect(resultFileName({ originalName: 'holiday.JPEG', inputType: 'image/jpeg', outputType: null })).toBe(
      'holiday.jpg',
    )
  })

  it('keeps the original name for a type this version does not know', () => {
    expect(resultFileName({ originalName: 'photo.heic', inputType: 'image/heic', outputType: 'image/heic' })).toBe(
      'photo.heic',
    )
  })
})

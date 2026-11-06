import { describe, expect, it } from 'vitest'

import { checkFile, resultFileName, savedPercent } from './files'

const LIMIT = 10 * 1024 * 1024

describe('checkFile', () => {
  it('accepts a supported image within the size limit', () => {
    expect(checkFile({ name: 'photo.jpg', type: 'image/jpeg', size: 2048 }, LIMIT)).toEqual({
      ok: true,
      request: { originalName: 'photo.jpg', contentType: 'image/jpeg', size: 2048, settings: { preset: 'balanced' } },
    })
    expect(checkFile({ name: 'graphic.png', type: 'image/png', size: LIMIT }, LIMIT).ok).toBe(true)
    expect(checkFile({ name: 'sticker.webp', type: 'image/webp', size: 10 }, LIMIT).ok).toBe(true)
    expect(checkFile({ name: 'render.avif', type: 'image/avif', size: 10 }, LIMIT).ok).toBe(true)
  })

  it('creates the job with the chosen preset', () => {
    const checked = checkFile({ name: 'photo.jpg', type: 'image/jpeg', size: 2048 }, LIMIT, 'smaller')

    expect(checked.ok && checked.request.settings).toEqual({ preset: 'smaller' })
  })

  it('takes the type from the extension when the browser reports none', () => {
    const checked = checkFile({ name: 'render.AVIF', type: '', size: 10 }, LIMIT)

    expect(checked.ok && checked.request.contentType).toBe('image/avif')
    expect(checkFile({ name: 'notes.txt', type: '', size: 10 }, LIMIT).ok).toBe(false)
  })

  it('rejects other types, empty files and files over the limit', () => {
    expect(checkFile({ name: 'a.gif', type: 'image/gif', size: 10 }, LIMIT)).toEqual({
      ok: false,
      reason: 'Only JPEG, PNG, WebP and AVIF',
    })
    expect(checkFile({ name: 'a.png', type: 'image/gif', size: 10 }, LIMIT).ok).toBe(false)
    expect(checkFile({ name: 'a.png', type: 'image/png', size: 0 }, LIMIT)).toEqual({
      ok: false,
      reason: 'The file is empty',
    })
    expect(checkFile({ name: 'a.png', type: 'image/png', size: LIMIT + 1 }, LIMIT)).toEqual({
      ok: false,
      reason: 'Larger than 10 MB',
    })
  })

  it("checks the size against the user's limit", () => {
    const limit = 5 * 1024 * 1024

    expect(checkFile({ name: 'a.png', type: 'image/png', size: limit }, limit).ok).toBe(true)
    expect(checkFile({ name: 'a.png', type: 'image/png', size: limit + 1 }, limit)).toEqual({
      ok: false,
      reason: 'Larger than 5.0 MB',
    })
  })

  it('rejects a name the API would refuse', () => {
    expect(checkFile({ name: 'a'.repeat(300), type: 'image/png', size: 10 }, LIMIT).ok).toBe(false)
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

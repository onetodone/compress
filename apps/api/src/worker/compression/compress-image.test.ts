import { COMPRESSION_PRESETS } from '@onetodone/compress-shared'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { fixture, type FixtureName } from '../../../test/support/fixtures.js'
import { compressImage, MAX_INPUT_PIXELS } from './compress-image.js'
import { PermanentJobError } from './permanent-job-error.js'

describe('compressImage', () => {
  const formats: [FixtureName, string, string][] = [
    ['photo.jpg', 'image/jpeg', 'jpeg'],
    ['graphic.png', 'image/png', 'png'],
    ['photo.webp', 'image/webp', 'webp'],
    ['photo.avif', 'image/avif', 'heif'],
  ]

  describe.each(COMPRESSION_PRESETS)('with the %s preset', (preset) => {
    it.each(formats)('compresses %s into a smaller file of the same format', async (name, type, sharpFormat) => {
      const input = fixture(name)

      const result = await compressImage(input, preset)

      expect(result).toMatchObject({ type, keptOriginal: false, width: 160, height: 120 })
      expect(result.data.length).toBeLessThan(input.length)
      expect((await sharp(result.data).metadata()).format).toBe(sharpFormat)
    })
  })

  it('makes smaller files with the smaller preset', async () => {
    for (const [name] of formats) {
      const balanced = await compressImage(fixture(name), 'balanced')
      const smaller = await compressImage(fixture(name), 'smaller')
      expect(smaller.data.length, name).toBeLessThan(balanced.data.length)
    }
  })

  it('re-encodes a JPEG into a smaller JPEG without metadata', async () => {
    const input = fixture('photo.jpg')

    const result = await compressImage(input)

    expect(result).toMatchObject({ type: 'image/jpeg', keptOriginal: false, width: 160, height: 120 })
    expect(result.data.length).toBeLessThan(input.length)
    const metadata = await sharp(result.data).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(metadata.exif).toBeUndefined()
  })

  it('quantizes a PNG into a smaller palette PNG', async () => {
    const input = fixture('graphic.png')

    const result = await compressImage(input)

    expect(result).toMatchObject({ type: 'image/png', keptOriginal: false, width: 160, height: 120 })
    expect(result.data.length).toBeLessThan(input.length)
    const metadata = await sharp(result.data).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.isPalette).toBe(true)
  })

  it('applies the EXIF orientation to the pixels', async () => {
    const rotated = await sharp(fixture('photo.jpg')).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer()

    const result = await compressImage(rotated)

    expect(result).toMatchObject({ width: 120, height: 160 })
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined()
  })

  it('keeps the original bytes when compression does not make the file smaller', async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer()

    const result = await compressImage(tiny)

    expect(result.keptOriginal).toBe(true)
    expect(result.data).toBe(tiny)
  })

  it('rejects a corrupt file as a permanent failure', async () => {
    await expect(compressImage(fixture('corrupt.jpg'))).rejects.toBeInstanceOf(PermanentJobError)
  })

  it('rejects bytes that are not an image', async () => {
    await expect(compressImage(Buffer.from('not an image'))).rejects.toThrow(
      'The file is not a valid JPEG, PNG, WebP or AVIF image',
    )
  })

  it('rejects image formats that are not supported', async () => {
    const gif = await sharp(fixture('photo.jpg')).gif().toBuffer()

    await expect(compressImage(gif)).rejects.toThrow('Only JPEG, PNG, WebP and AVIF images are supported')
  })

  it('rejects animated images instead of keeping only the first frame', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer()
    const animated = await sharp([await frame('#f00'), await frame('#00f')], { join: { animated: true } })
      .webp()
      .toBuffer()

    await expect(compressImage(animated)).rejects.toThrow('Animated images are not supported')
  })

  it('rejects images above the pixel limit before decoding them', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1
    const huge = await sharp({ create: { width: side, height: side, channels: 3, background: '#000' } })
      .png({ compressionLevel: 9 })
      .toBuffer()

    await expect(compressImage(huge)).rejects.toThrow('too many pixels')
  })
})

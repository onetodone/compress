import { describe, expect, it } from 'vitest'

import {
  defineFileFormats,
  describeInputLimits,
  downloadFileName,
  fileFormats,
  IMAGE_TYPES,
  isImageType,
  MAX_INPUT_BYTES,
} from './format.js'

const MB = 1024 * 1024

describe('fileFormats', () => {
  it('lists JPEG, PNG, WebP, AVIF, HEIC and PDF', () => {
    expect(fileFormats.types).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/heic',
      'application/pdf',
    ])
    expect(fileFormats.names('and')).toBe('JPEG, PNG, WebP, AVIF, HEIC and PDF')
    expect(fileFormats.names('or', IMAGE_TYPES)).toBe('JPEG, PNG, WebP, AVIF or HEIC')
  })

  it('tells images from documents', () => {
    expect(IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic'])
    expect(fileFormats.ofKind('document')).toEqual(['application/pdf'])
    expect(isImageType('image/avif')).toBe(true)
    expect(isImageType('image/heic')).toBe(true)
    expect(isImageType('application/pdf')).toBe(false)
  })

  it('limits every format to 20 MB', () => {
    for (const type of fileFormats.types) expect(fileFormats.info(type).maxBytes).toBe(20 * MB)
    expect(fileFormats.info('application/pdf').maxBytes).toBe(20 * MB)
    expect(MAX_INPUT_BYTES).toBe(20 * MB)
  })

  it('accepts every format and extension in a file input, or only the given ones', () => {
    expect(fileFormats.accept()).toBe(
      'image/jpeg,image/png,image/webp,image/avif,image/heic,application/pdf,.jpg,.jpeg,.jpe,.jfif,.png,.webp,.avif,.heic,.heif,.pdf',
    )
    expect(fileFormats.accept(['image/png', 'application/pdf'])).toBe('image/png,application/pdf,.png,.pdf')
  })

  it('validates only the registered MIME types', () => {
    expect(fileFormats.schema.parse('image/avif')).toBe('image/avif')
    expect(fileFormats.schema.parse('application/pdf')).toBe('application/pdf')
    expect(fileFormats.schema.safeParse('image/gif').success).toBe(false)
    expect(fileFormats.schema.parse('image/heic')).toBe('image/heic')
    expect(fileFormats.schema.safeParse('image/jxl').success).toBe(false)
  })

  it('maps MIME types and their aliases to types', () => {
    expect(fileFormats.typeOfMimeType('image/heic')).toBe('image/heic')
    expect(fileFormats.typeOfMimeType('image/heif')).toBe('image/heic')
    expect(fileFormats.typeOfMimeType('IMAGE/JPEG')).toBe('image/jpeg')
    expect(fileFormats.typeOfMimeType('image/gif')).toBeUndefined()
  })

  it('maps extensions and file names to types in any case', () => {
    expect(fileFormats.typeOfExtension('JPEG')).toBe('image/jpeg')
    expect(fileFormats.typeOfExtension('.avif')).toBe('image/avif')
    expect(fileFormats.typeOfExtension('HEIF')).toBe('image/heic')
    expect(fileFormats.typeOfExtension('gif')).toBeUndefined()
    expect(fileFormats.typeOfFileName('Report.PDF')).toBe('application/pdf')
    expect(fileFormats.typeOfFileName('.pdf')).toBeUndefined()
    expect(fileFormats.typeOfFileName('notes')).toBeUndefined()
  })

  it('writes files with the first extension of a format', () => {
    expect(fileFormats.extension('image/jpeg')).toBe('jpg')
    expect(fileFormats.extension('application/pdf')).toBe('pdf')
  })

  it('strips any known extension and nothing else', () => {
    expect(fileFormats.stripExtension('holiday.JFIF')).toBe('holiday')
    expect(fileFormats.stripExtension('report.pdf')).toBe('report')
    expect(fileFormats.stripExtension('report.v2')).toBe('report.v2')
    expect(fileFormats.stripExtension('archive.png.zip')).toBe('archive.png.zip')
    expect(fileFormats.stripExtension('.png')).toBe('.png')
    expect(fileFormats.stripExtension('logo')).toBe('logo')
  })
})

describe('defineFileFormats', () => {
  it('derives everything for a format added to the registry', () => {
    const formats = defineFileFormats({
      'image/png': { name: 'PNG', kind: 'image', extensions: ['png'], maxBytes: 10 },
      'text/x-fake': { name: 'Fake', kind: 'document', extensions: ['fake', 'fk'], maxBytes: 20 },
    })

    expect(formats.schema.parse('text/x-fake')).toBe('text/x-fake')
    expect(formats.accept()).toBe('image/png,text/x-fake,.png,.fake,.fk')
    expect(formats.extension('text/x-fake')).toBe('fake')
    expect(formats.typeOfExtension('FK')).toBe('text/x-fake')
    expect(formats.stripExtension('drawing.fk')).toBe('drawing')
    expect(formats.names('or')).toBe('PNG or Fake')
    expect(formats.ofKind('image')).toEqual(['image/png'])
    expect(formats.info('text/x-fake').name).toBe('Fake')
  })

  it('names a single format without a conjunction', () => {
    const formats = defineFileFormats({ 'image/png': { name: 'PNG', kind: 'image', extensions: ['png'], maxBytes: 1 } })
    expect(formats.names('and')).toBe('PNG')
  })
})

describe('describeInputLimits', () => {
  it('names formats with the same limit together', () => {
    const images = Object.fromEntries(IMAGE_TYPES.map((type) => [type, 10 * MB]))

    expect(describeInputLimits({ ...images, 'application/pdf': 20 * MB })).toBe(
      'JPEG, PNG, WebP, AVIF or HEIC up to 10 MB each, PDF up to 20 MB',
    )
    expect(describeInputLimits(images)).toBe('JPEG, PNG, WebP, AVIF or HEIC up to 10 MB each')
    expect(describeInputLimits({ 'application/pdf': 20 * MB })).toBe('PDF up to 20 MB')
  })
})

describe('downloadFileName', () => {
  it('keeps the name and uses the extension of the detected type', () => {
    expect(downloadFileName('holiday.jpg', 'image/jpeg')).toBe('holiday.jpg')
    expect(downloadFileName('holiday.JPEG', 'image/jpeg')).toBe('holiday.jpg')
    expect(downloadFileName('scan.jpg', 'image/png')).toBe('scan.png')
    expect(downloadFileName('Contract.PDF', 'application/pdf')).toBe('Contract.pdf')
  })

  it('replaces any known extension', () => {
    expect(downloadFileName('sticker.WEBP', 'image/webp')).toBe('sticker.webp')
    expect(downloadFileName('scan.jfif', 'image/jpeg')).toBe('scan.jpg')
    expect(downloadFileName('render.avif', 'image/avif')).toBe('render.avif')
    expect(downloadFileName('IMG_1099.HEIF', 'image/heic')).toBe('IMG_1099.heic')
  })

  it('appends the extension when the name has no known extension', () => {
    expect(downloadFileName('logo', 'image/png')).toBe('logo.png')
    expect(downloadFileName('report.v2', 'application/pdf')).toBe('report.v2.pdf')
  })
})

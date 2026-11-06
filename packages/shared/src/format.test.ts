import { describe, expect, it } from 'vitest'

import { defineImageFormats, downloadFileName, imageFormats } from './format.js'

describe('imageFormats', () => {
  it('lists JPEG, PNG, WebP and AVIF', () => {
    expect(imageFormats.types).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
    expect(imageFormats.names('and')).toBe('JPEG, PNG, WebP and AVIF')
    expect(imageFormats.names('or')).toBe('JPEG, PNG, WebP or AVIF')
  })

  it('accepts every format and extension in a file input', () => {
    expect(imageFormats.accept).toBe(
      'image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.jpe,.jfif,.png,.webp,.avif',
    )
  })

  it('validates only the registered MIME types', () => {
    expect(imageFormats.schema.parse('image/avif')).toBe('image/avif')
    expect(imageFormats.schema.safeParse('image/gif').success).toBe(false)
    expect(imageFormats.schema.safeParse('image/heic').success).toBe(false)
  })

  it('maps extensions to types in any case, with or without the dot', () => {
    expect(imageFormats.typeOfExtension('JPEG')).toBe('image/jpeg')
    expect(imageFormats.typeOfExtension('.avif')).toBe('image/avif')
    expect(imageFormats.typeOfExtension('gif')).toBeUndefined()
  })

  it('writes files with the first extension of a format', () => {
    expect(imageFormats.extension('image/jpeg')).toBe('jpg')
    expect(imageFormats.extension('image/webp')).toBe('webp')
  })

  it('strips any known image extension and nothing else', () => {
    expect(imageFormats.stripExtension('holiday.JFIF')).toBe('holiday')
    expect(imageFormats.stripExtension('sticker.webp')).toBe('sticker')
    expect(imageFormats.stripExtension('report.v2')).toBe('report.v2')
    expect(imageFormats.stripExtension('archive.png.zip')).toBe('archive.png.zip')
    expect(imageFormats.stripExtension('.png')).toBe('.png')
    expect(imageFormats.stripExtension('logo')).toBe('logo')
  })
})

describe('defineImageFormats', () => {
  it('derives everything for a format added to the registry', () => {
    const formats = defineImageFormats({
      'image/png': { name: 'PNG', extensions: ['png'] },
      'image/x-fake': { name: 'Fake', extensions: ['fake', 'fk'] },
    })

    expect(formats.schema.parse('image/x-fake')).toBe('image/x-fake')
    expect(formats.accept).toBe('image/png,image/x-fake,.png,.fake,.fk')
    expect(formats.extension('image/x-fake')).toBe('fake')
    expect(formats.typeOfExtension('FK')).toBe('image/x-fake')
    expect(formats.stripExtension('drawing.fk')).toBe('drawing')
    expect(formats.names('or')).toBe('PNG or Fake')
    expect(formats.info('image/x-fake').name).toBe('Fake')
  })

  it('names a single format without a conjunction', () => {
    expect(defineImageFormats({ 'image/png': { name: 'PNG', extensions: ['png'] } }).names('and')).toBe('PNG')
  })
})

describe('downloadFileName', () => {
  it('keeps the name and uses the extension of the detected type', () => {
    expect(downloadFileName('holiday.jpg', 'image/jpeg')).toBe('holiday.jpg')
    expect(downloadFileName('holiday.JPEG', 'image/jpeg')).toBe('holiday.jpg')
    expect(downloadFileName('scan.jpg', 'image/png')).toBe('scan.png')
  })

  it('replaces any known image extension', () => {
    expect(downloadFileName('sticker.WEBP', 'image/webp')).toBe('sticker.webp')
    expect(downloadFileName('scan.jfif', 'image/jpeg')).toBe('scan.jpg')
    expect(downloadFileName('render.avif', 'image/avif')).toBe('render.avif')
  })

  it('appends the extension when the name has no image extension', () => {
    expect(downloadFileName('logo', 'image/png')).toBe('logo.png')
    expect(downloadFileName('report.v2', 'image/jpeg')).toBe('report.v2.jpg')
  })
})

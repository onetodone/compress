import { describe, expect, it } from 'vitest'

import { contentDisposition, downloadFileName } from './content-disposition.js'

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

describe('contentDisposition', () => {
  it('passes a plain ASCII name through', () => {
    expect(contentDisposition('attachment', 'photo.jpg')).toBe(
      `attachment; filename="photo.jpg"; filename*=UTF-8''photo.jpg`,
    )
  })

  it('lets the browser display the file inline', () => {
    expect(contentDisposition('inline', 'photo.jpg')).toBe(`inline; filename="photo.jpg"; filename*=UTF-8''photo.jpg`)
  })

  it('encodes non-ASCII names and gives older browsers an ASCII fallback', () => {
    expect(contentDisposition('attachment', 'фото 1.png')).toBe(
      `attachment; filename="____ 1.png"; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE%201.png`,
    )
  })

  it('cannot be broken out of by quotes or reserved characters', () => {
    expect(contentDisposition('attachment', `a"b'c(1)*%.jpg`)).toBe(
      `attachment; filename="a_b'c(1)*_.jpg"; filename*=UTF-8''a%22b%27c%281%29%2A%25.jpg`,
    )
  })
})

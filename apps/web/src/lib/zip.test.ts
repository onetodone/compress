import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { buildZip, uniqueFileNames } from './zip'

describe('uniqueFileNames', () => {
  it('keeps distinct names as they are', () => {
    expect(uniqueFileNames(['a.jpg', 'b.png', 'a.png'])).toEqual(['a.jpg', 'b.png', 'a.png'])
  })

  it('numbers repeated names before the extension, ignoring case', () => {
    expect(uniqueFileNames(['photo.jpg', 'photo.jpg', 'PHOTO.jpg', 'logo', 'logo'])).toEqual([
      'photo.jpg',
      'photo (2).jpg',
      'PHOTO (3).jpg',
      'logo',
      'logo (2)',
    ])
  })

  it('skips numbers a later original name would collide with', () => {
    expect(uniqueFileNames(['photo (2).jpg', 'photo.jpg', 'photo.jpg'])).toEqual([
      'photo (2).jpg',
      'photo.jpg',
      'photo (3).jpg',
    ])
  })

  it('never creates folders or empty names', () => {
    expect(uniqueFileNames(['../../etc/passwd.png', 'a\\b.jpg', '..', ' '])).toEqual([
      '.._.._etc_passwd.png',
      'a_b.jpg',
      'image',
      'image (2)',
    ])
  })
})

describe('buildZip', () => {
  it('stores every file under its name', () => {
    const zip = buildZip([
      { name: 'photo.jpg', data: strToU8('first') },
      { name: 'photo (2).jpg', data: strToU8('second') },
    ])
    const files = unzipSync(zip)
    expect(Object.keys(files)).toEqual(['photo.jpg', 'photo (2).jpg'])
    expect(strFromU8(files['photo (2).jpg']!)).toBe('second')
  })
})

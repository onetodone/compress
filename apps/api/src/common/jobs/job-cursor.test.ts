import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import { decodeJobCursor, encodeJobCursor } from './job-cursor.js'

describe('job cursor', () => {
  const id = 'a1B2c3D4e5F6g7H8i9J0'

  it('round-trips the creation time with nanosecond precision and the job id', () => {
    const cursor = { createdAt: new Timestamp(1_792_000_000, 123_456_789), id }

    const decoded = decodeJobCursor(encodeJobCursor(cursor))

    expect(decoded?.id).toBe(id)
    expect(decoded?.createdAt.isEqual(cursor.createdAt)).toBe(true)
  })

  it('rejects values that were not produced by the encoder', () => {
    const encode = (text: string) => Buffer.from(text).toString('base64url')

    for (const value of ['garbage', encode('1.2'), encode('1.2.not/a/job'), encode(`x.0.${id}`)]) {
      expect(decodeJobCursor(value)).toBeNull()
    }
  })
})

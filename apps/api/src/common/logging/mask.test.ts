import { describe, expect, it } from 'vitest'

import { maskSensitive, maskString, REDACTED } from './mask.js'

describe('maskString', () => {
  it('masks the signature and credential of a presigned URL but keeps the rest', () => {
    const url =
      'https://acc.r2.cloudflarestorage.com/bucket/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261022&X-Amz-Expires=600&X-Amz-Signature=deadbeef'

    const masked = maskString(url)

    expect(masked).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(masked).toContain(`X-Amz-Credential=${REDACTED}&`)
    expect(masked).toContain(`X-Amz-Signature=${REDACTED}`)
    expect(masked).not.toContain('deadbeef')
    expect(masked).not.toContain('AKIA')
  })

  it('masks bearer tokens and bare JWTs', () => {
    expect(maskString('Authorization: Bearer abc.def-ghi')).toBe(`Authorization: Bearer ${REDACTED}`)
    expect(maskString('token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln here')).toBe(`token ${REDACTED} here`)
  })

  it('masks the credentials of a Cloudinary URL', () => {
    expect(maskString('cloudinary://key:secret@demo')).toBe(`cloudinary://${REDACTED}@demo`)
  })

  it('masks a Telegram bot token inside a Bot API URL', () => {
    const url = 'https://api.telegram.org/file/bot1234567890:AAH-x_yZ0123456789abcdefghijklmnopq/documents/file_1.jpg'

    expect(maskString(url)).toBe(`https://api.telegram.org/file/bot${REDACTED}/documents/file_1.jpg`)
  })

  it('leaves ordinary text untouched', () => {
    expect(maskString('GET /jobs/abc 200')).toBe('GET /jobs/abc 200')
  })
})

describe('maskSensitive', () => {
  it('replaces values under credential-like keys at any depth', () => {
    const masked = maskSensitive({
      headers: { Authorization: 'Bearer x', 'user-agent': 'curl' },
      nested: { idToken: 'abc', R2_SECRET_ACCESS_KEY: 'xyz', jobId: 'job-1' },
    })

    expect(masked).toEqual({
      headers: { Authorization: REDACTED, 'user-agent': 'curl' },
      nested: { idToken: REDACTED, R2_SECRET_ACCESS_KEY: REDACTED, jobId: 'job-1' },
    })
  })

  it('masks strings inside arrays and error messages', () => {
    const error = new Error('PUT https://r2/key?X-Amz-Signature=abc failed')

    const masked = maskSensitive({ urls: ['https://r2/key?X-Amz-Signature=abc'], err: error }) as {
      urls: string[]
      err: { type: string; message: string }
    }

    expect(masked.urls[0]).toBe(`https://r2/key?X-Amz-Signature=${REDACTED}`)
    expect(masked.err.type).toBe('Error')
    expect(masked.err.message).toBe(`PUT https://r2/key?X-Amz-Signature=${REDACTED} failed`)
  })

  it('does not loop on circular references', () => {
    const value: Record<string, unknown> = { name: 'a' }
    value.self = value

    expect(maskSensitive(value)).toEqual({ name: 'a', self: '[Truncated]' })
  })

  it('does not modify the original object', () => {
    const value = { token: 'abc' }

    maskSensitive(value)

    expect(value.token).toBe('abc')
  })
})

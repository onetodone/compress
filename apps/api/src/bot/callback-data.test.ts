import { describe, expect, it } from 'vitest'

import { type CallbackAction, encodeCallback, parseCallback } from './callback-data.js'

const JOB_ID = 'a1B2c3D4e5F6g7H8i9J0'

describe('callback data', () => {
  const actions: CallbackAction[] = [
    { type: 'page', page: 0 },
    { type: 'page', page: 12 },
    { type: 'download', jobId: JOB_ID },
    { type: 'askDelete', jobId: JOB_ID, page: 3 },
    { type: 'delete', jobId: JOB_ID, page: 0 },
  ]

  it.each(actions)('reads back what it encodes: %o', (action) => {
    const data = encodeCallback(action)

    expect(parseCallback(data)).toEqual(action)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  })

  it.each([
    '',
    'p',
    'p:-1',
    'p:1.5',
    'p:99999',
    'p:1:2',
    'd:not-a-job-id',
    `d:${JOB_ID}:1`,
    `a:${JOB_ID}`,
    `x:${JOB_ID}:x`,
    `z:${JOB_ID}:1`,
  ])('refuses data it does not know: %j', (data) => {
    expect(parseCallback(data)).toBeNull()
  })
})

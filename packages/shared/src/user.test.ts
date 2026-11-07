import { describe, expect, it } from 'vitest'

import { inputLimitsOf } from './user.js'

const MB = 1024 * 1024

describe('inputLimitsOf', () => {
  it('reads the formats the API lists, leaving out unknown ones', () => {
    expect(
      inputLimitsOf({
        maxInputBytes: 10 * MB,
        formats: [
          { type: 'image/png', maxBytes: 10 * MB },
          { type: 'application/pdf', maxBytes: 20 * MB },
          { type: 'image/x-future', maxBytes: 5 * MB },
        ],
      }),
    ).toEqual({ 'image/png': 10 * MB, 'application/pdf': 20 * MB })
  })

  it('covers the image formats of an API that lists no formats', () => {
    expect(inputLimitsOf({ maxInputBytes: 10 * MB })).toEqual({
      'image/jpeg': 10 * MB,
      'image/png': 10 * MB,
      'image/webp': 10 * MB,
      'image/avif': 10 * MB,
    })
  })
})

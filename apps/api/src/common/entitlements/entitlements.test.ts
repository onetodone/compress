import { FILE_TYPES, fileFormats } from '@onetodone/compress-shared'
import { describe, expect, it } from 'vitest'

import { entitlementsFor } from './entitlements.js'

const MB = 1024 * 1024
const config = {
  QUOTA_ANONYMOUS_DAILY: 5,
  QUOTA_SIGNED_IN_DAILY: 30,
  QUOTA_ANONYMOUS_PER_IP_DAILY: 20,
  GHOSTSCRIPT_PATH: 'gs',
}
const allTypes = {
  'image/jpeg': 20 * MB,
  'image/png': 20 * MB,
  'image/webp': 20 * MB,
  'image/avif': 20 * MB,
  'application/pdf': 20 * MB,
}

describe('entitlementsFor', () => {
  it('gives an anonymous user the anonymous daily limit and a per-network limit', () => {
    expect(entitlementsFor({ kind: 'anonymous' }, 'free', config)).toEqual({
      dailyJobs: 5,
      inputLimits: allTypes,
      networkLimited: true,
    })
  })

  it('gives a registered user the signed-in daily limit without a per-network limit', () => {
    expect(entitlementsFor({ kind: 'registered' }, 'free', config)).toEqual({
      dailyJobs: 30,
      inputLimits: allTypes,
      networkLimited: false,
    })
  })

  it('drops the per-network limit when it is disabled', () => {
    const disabled = { ...config, QUOTA_ANONYMOUS_PER_IP_DAILY: 0 }

    expect(entitlementsFor({ kind: 'anonymous' }, 'free', disabled).networkLimited).toBe(false)
  })

  it('accepts only images when PDF compression is off', () => {
    const { inputLimits } = entitlementsFor({ kind: 'registered' }, 'free', { ...config, GHOSTSCRIPT_PATH: undefined })

    expect(Object.keys(inputLimits)).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
  })

  it('never allows files above the ceiling of their format', () => {
    for (const kind of ['anonymous', 'registered'] as const) {
      const { inputLimits } = entitlementsFor({ kind }, 'free', config)
      for (const type of FILE_TYPES) expect(inputLimits[type]).toBeLessThanOrEqual(fileFormats.info(type).maxBytes)
    }
  })
})

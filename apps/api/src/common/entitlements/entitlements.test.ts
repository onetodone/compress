import { MAX_INPUT_BYTES } from '@onetodone/compress-shared'
import { describe, expect, it } from 'vitest'

import { entitlementsFor } from './entitlements.js'

const config = { QUOTA_ANONYMOUS_DAILY: 5, QUOTA_SIGNED_IN_DAILY: 30, QUOTA_ANONYMOUS_PER_IP_DAILY: 20 }

describe('entitlementsFor', () => {
  it('gives an anonymous user the anonymous daily limit and a per-network limit', () => {
    expect(entitlementsFor({ kind: 'anonymous' }, 'free', config)).toEqual({
      dailyJobs: 5,
      maxInputBytes: MAX_INPUT_BYTES,
      networkLimited: true,
    })
  })

  it('gives a registered user the signed-in daily limit without a per-network limit', () => {
    expect(entitlementsFor({ kind: 'registered' }, 'free', config)).toEqual({
      dailyJobs: 30,
      maxInputBytes: MAX_INPUT_BYTES,
      networkLimited: false,
    })
  })

  it('drops the per-network limit when it is disabled', () => {
    const disabled = { ...config, QUOTA_ANONYMOUS_PER_IP_DAILY: 0 }

    expect(entitlementsFor({ kind: 'anonymous' }, 'free', disabled).networkLimited).toBe(false)
  })

  it('never allows files above the absolute ceiling', () => {
    for (const kind of ['anonymous', 'registered'] as const) {
      expect(entitlementsFor({ kind }, 'free', config).maxInputBytes).toBeLessThanOrEqual(MAX_INPUT_BYTES)
    }
  })
})

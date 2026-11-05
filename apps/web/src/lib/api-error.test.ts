import { describe, expect, it } from 'vitest'

import { apiErrorMessage } from './api-error'

describe('apiErrorMessage', () => {
  it('explains the daily limit', () => {
    expect(apiErrorMessage(429, { message: 'Daily job limit reached' })).toBe(
      'Daily limit reached. Try again tomorrow.',
    )
  })

  it('suggests signing in when the network limit is reached', () => {
    expect(
      apiErrorMessage(429, { message: 'Daily job limit of this network reached', code: 'network_daily_limit' }),
    ).toBe('Too many images from your network today. Sign in to continue.')
    expect(apiErrorMessage(429, { code: 'daily_limit' })).toBe('Daily limit reached. Try again tomorrow.')
  })

  it('shows the message of a client error', () => {
    expect(apiErrorMessage(409, { statusCode: 409, message: 'The file has not been uploaded' })).toBe(
      'The file has not been uploaded',
    )
  })

  it('never shows the details of a server error', () => {
    expect(apiErrorMessage(500, { message: 'Firestore internal: deadline exceeded' })).toBe(
      'Something went wrong. Try again.',
    )
    expect(apiErrorMessage(400, undefined)).toBe('Something went wrong. Try again.')
  })
})

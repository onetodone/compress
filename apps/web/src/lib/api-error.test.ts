import { describe, expect, it } from 'vitest'

import { apiError, apiErrorMessage, quotaLimitMessage } from './api-error'

describe('apiErrorMessage', () => {
  it('explains the daily limit', () => {
    expect(apiErrorMessage(429, { message: 'Daily job limit reached' })).toBe(
      'Daily limit reached. Try again tomorrow.',
    )
  })

  it('suggests signing in when the network limit is reached', () => {
    expect(
      apiErrorMessage(429, { message: 'Daily job limit of this network reached', code: 'network_daily_limit' }),
    ).toBe('Too many files from your network today. Sign in to continue.')
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

describe('apiError', () => {
  it('keeps the limit of a refused job', () => {
    expect(apiError(429, { code: 'network_daily_limit' }).quotaCode).toBe('network_daily_limit')
    expect(apiError(429, { code: 'daily_limit' }).quotaCode).toBe('daily_limit')
    expect(apiError(429, { code: 'something_else' }).quotaCode).toBe('daily_limit')
  })

  it('has no limit for other errors', () => {
    expect(apiError(400, { message: 'Bad' })).toMatchObject({ status: 400, message: 'Bad', quotaCode: null })
  })
})

describe('quotaLimitMessage', () => {
  it('suggests signing in to anonymous users only', () => {
    expect(quotaLimitMessage('daily_limit', 'anonymous')).toBe(
      'Daily limit reached. Sign in for more, or try again tomorrow.',
    )
    expect(quotaLimitMessage('daily_limit', 'registered')).toBe('Daily limit reached. Try again tomorrow.')
    expect(quotaLimitMessage('network_daily_limit', 'anonymous')).toBe(
      'Too many files from your network today. Sign in to continue.',
    )
  })
})

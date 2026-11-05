import { describe, expect, it } from 'vitest'

import { signInErrorMessage } from './account'

describe('signInErrorMessage', () => {
  it('treats a closed or replaced popup as a cancellation', () => {
    for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']) {
      expect(signInErrorMessage(code)).toBeNull()
    }
  })

  it('explains a blocked popup', () => {
    expect(signInErrorMessage('auth/popup-blocked')).toMatch(/allow popups/i)
  })

  it('explains a network failure', () => {
    expect(signInErrorMessage('auth/network-request-failed')).toMatch(/connection/i)
  })

  it('falls back to a generic message for other errors', () => {
    expect(signInErrorMessage('auth/internal-error')).toBe('Could not sign in. Try again.')
    expect(signInErrorMessage('')).toBe('Could not sign in. Try again.')
  })
})

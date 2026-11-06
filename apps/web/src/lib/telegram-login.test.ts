import { describe, expect, it } from 'vitest'

import { loginCodeFromHash } from './telegram-login'

const CODE = 'Ab-_0123456789abcdefgh'

describe('loginCodeFromHash', () => {
  it('reads the code with or without the leading #', () => {
    expect(loginCodeFromHash(`#telegram-login=${CODE}`)).toBe(CODE)
    expect(loginCodeFromHash(`telegram-login=${CODE}`)).toBe(CODE)
  })

  it('ignores a missing or malformed code', () => {
    expect(loginCodeFromHash('')).toBeNull()
    expect(loginCodeFromHash('#other=1')).toBeNull()
    expect(loginCodeFromHash('#telegram-login=short')).toBeNull()
    expect(loginCodeFromHash(`#telegram-login=${CODE}x`)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { formatBytes } from './bytes.js'

describe('formatBytes', () => {
  it('uses the largest unit that keeps the value above 1', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(19_879)).toBe('19 KB')
    expect(formatBytes(3_313)).toBe('3.2 KB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
  })
})

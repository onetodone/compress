import { describe, expect, it } from 'vitest'

import { GHOSTSCRIPT_PATH, ghostscriptAvailable } from '../../../test/support/ghostscript.js'
import { GhostscriptPdfCompressor, UnavailablePdfCompressor } from './compress-pdf.js'
import { createPdfCompressor } from './compression.module.js'

describe('createPdfCompressor', () => {
  it('turns PDF compression off without GHOSTSCRIPT_PATH', async () => {
    expect(await createPdfCompressor({ GHOSTSCRIPT_PATH: undefined })).toBeInstanceOf(UnavailablePdfCompressor)
  })

  it('refuses to start with a Ghostscript that cannot be run', async () => {
    await expect(createPdfCompressor({ GHOSTSCRIPT_PATH: '/nonexistent/gs' })).rejects.toThrow(
      'GHOSTSCRIPT_PATH: cannot run /nonexistent/gs',
    )
  })

  it.runIf(ghostscriptAvailable)('uses Ghostscript when it can be run', async () => {
    expect(await createPdfCompressor({ GHOSTSCRIPT_PATH })).toBeInstanceOf(GhostscriptPdfCompressor)
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GHOSTSCRIPT_PATH, ghostscriptAvailable } from '../../../test/support/ghostscript.js'
import { HEIF_TOOLS_DIR, heifToolsAvailable } from '../../../test/support/heif.js'
import { LibheifHeicEncoder, UnavailableHeicEncoder } from './compress-heic.js'
import { GhostscriptPdfCompressor, UnavailablePdfCompressor } from './compress-pdf.js'
import { createHeicEncoder, createPdfCompressor } from './compression.module.js'

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

describe('createHeicEncoder', () => {
  it('turns HEIC compression off without HEIF_TOOLS_DIR', async () => {
    expect(await createHeicEncoder({ HEIF_TOOLS_DIR: undefined })).toBeInstanceOf(UnavailableHeicEncoder)
  })

  it('refuses to start with libheif tools that cannot be run', async () => {
    await expect(createHeicEncoder({ HEIF_TOOLS_DIR: '/nonexistent' })).rejects.toThrow(
      'HEIF_TOOLS_DIR: cannot use heif-dec and heif-enc in /nonexistent',
    )
  })

  it('refuses to start when the tools have no HEVC codec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heif-tools-'))
    try {
      // Tools that run but cannot encode, as libheif does without its codec plugins.
      for (const tool of ['heif-dec', 'heif-enc']) {
        const script =
          '#!/bin/sh\n[ "$1" = --version ] && echo 1.21.2 && exit 0\necho "Unsupported codec" >&2\nexit 1\n'
        await writeFile(join(dir, tool), script, { mode: 0o755 })
      }

      const error = await createHeicEncoder({ HEIF_TOOLS_DIR: dir }).catch((caught: unknown) => caught)

      expect(error).toEqual(new Error(`HEIF_TOOLS_DIR: cannot use heif-dec and heif-enc in ${dir}`))
      expect((error as Error).cause).toEqual(new Error('heif-enc cannot encode HEIC images (libheif-plugin-x265)'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.runIf(heifToolsAvailable)('uses libheif when its tools can be run', async () => {
    expect(await createHeicEncoder({ HEIF_TOOLS_DIR })).toBeInstanceOf(LibheifHeicEncoder)
  })
})

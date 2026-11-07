import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'

import { fixture } from '../../../test/support/fixtures.js'
import { HEIF_TOOLS_DIR, heifToolsAvailable } from '../../../test/support/heif.js'
import { LibheifHeicEncoder, UnavailableHeicEncoder } from './compress-heic.js'
import { MAX_INPUT_PIXELS } from './compress-image.js'
import { PermanentJobError } from './permanent-job-error.js'

describe('UnavailableHeicEncoder', () => {
  it('fails every image permanently', async () => {
    await expect(new UnavailableHeicEncoder().encode()).rejects.toThrow(
      new PermanentJobError('HEIC compression is not available'),
    )
  })
})

describe('LibheifHeicEncoder with stand-in tools', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'compress-heic-test-'))

  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  /** A directory whose `heif-dec` and `heif-enc` run the given shell script. */
  function tools(name: string, script: string): string {
    const dir = mkdtempSync(join(scratch, `${name}-`))
    for (const tool of ['heif-dec', 'heif-enc'])
      writeFileSync(join(dir, tool), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return dir
  }

  it('rejects an image the decoder reports as damaged although it exits normally', async () => {
    const encoder = new LibheifHeicEncoder(
      tools('warning', 'echo "Warning: Invalid input: Unexpected end of file" >&2'),
    )

    const error = await encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS).catch((caught) => caught)

    expect(error).toBeInstanceOf(PermanentJobError)
    expect(error).toMatchObject({
      message: 'The HEIC image is damaged and cannot be compressed',
      detail: expect.stringContaining('Unexpected end of file'),
    })
  })

  it('rejects an image the decoder refuses', async () => {
    const encoder = new LibheifHeicEncoder(tools('refused', 'echo "Could not read HEIF/AVIF file" >&2; exit 1'))

    await expect(encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS)).rejects.toThrow(
      'The file is not a valid HEIC image',
    )
  })

  it('gives up on an image that takes too long', async () => {
    const encoder = new LibheifHeicEncoder(tools('slow', 'sleep 5'), 100)

    await expect(encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS)).rejects.toThrow(
      'The HEIC image takes too long to compress',
    )
  })

  it('fails with an ordinary error when a tool is killed from outside, so the task is retried', async () => {
    const encoder = new LibheifHeicEncoder(tools('killed', 'kill -9 $$'))

    const error = await encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PermanentJobError)
  })

  it('fails with an ordinary error when the tools cannot be started', async () => {
    const encoder = new LibheifHeicEncoder(join(scratch, 'no-such-dir'))

    const error = await encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PermanentJobError)
  })

  it('encodes one image at a time', async () => {
    const log = join(scratch, 'runs.log')
    const encoder = new LibheifHeicEncoder(
      tools('serial', `echo start >> ${log}; sleep 0.2; echo end >> ${log}; exit 1`),
    )

    const runs = [1, 2].map(() => encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS))
    await Promise.allSettled(runs)

    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end'])
  })
})

describe.runIf(heifToolsAvailable)('LibheifHeicEncoder', () => {
  const encoder = new LibheifHeicEncoder(HEIF_TOOLS_DIR!)

  it('reports the libheif version', async () => {
    expect(await encoder.check()).toMatch(/^\d+\.\d+/)
  })

  it('encodes an HEIC image again without metadata', async () => {
    const result = await encoder.encode(fixture('photo.heic'), 'balanced', MAX_INPUT_PIXELS)

    expect(result).toMatchObject({ width: 160, height: 120 })
    const metadata = await sharp(result.data).metadata()
    expect(metadata).toMatchObject({ format: 'heif', compression: 'hevc', width: 160, height: 120 })
    expect(metadata.exif).toBeUndefined()
  })

  it('rejects a truncated file', async () => {
    const truncated = fixture('photo.heic').subarray(0, 12_000)

    await expect(encoder.encode(truncated, 'balanced', MAX_INPUT_PIXELS)).rejects.toBeInstanceOf(PermanentJobError)
  })

  it('rejects an image above the pixel limit', async () => {
    await expect(encoder.encode(fixture('photo.heic'), 'balanced', 100)).rejects.toThrow('too many pixels')
  })
})

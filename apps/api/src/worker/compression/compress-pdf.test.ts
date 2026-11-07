import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { fixture } from '../../../test/support/fixtures.js'
import { GHOSTSCRIPT_PATH, ghostscriptAvailable, textOnlyPdf } from '../../../test/support/ghostscript.js'
import { GhostscriptPdfCompressor, isPdf, UnavailablePdfCompressor } from './compress-pdf.js'
import { PermanentJobError } from './permanent-job-error.js'

describe('isPdf', () => {
  it('finds the signature at the start or after leading junk', () => {
    expect(isPdf(fixture('document.pdf'))).toBe(true)
    expect(isPdf(Buffer.concat([Buffer.from('junk\n'), fixture('document.pdf')]))).toBe(true)
  })

  it('does not take images or text for PDF documents', () => {
    expect(isPdf(fixture('photo.jpg'))).toBe(false)
    expect(isPdf(Buffer.from('%PDF'))).toBe(false)
  })
})

describe('UnavailablePdfCompressor', () => {
  it('fails every document permanently', async () => {
    await expect(new UnavailablePdfCompressor().compress()).rejects.toThrow(
      new PermanentJobError('PDF compression is not available'),
    )
  })
})

describe.runIf(ghostscriptAvailable)('GhostscriptPdfCompressor', () => {
  const compressor = new GhostscriptPdfCompressor(GHOSTSCRIPT_PATH)
  const scratch = mkdtempSync(join(tmpdir(), 'compress-pdf-test-'))

  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it('reports the Ghostscript version', async () => {
    expect(await compressor.version()).toMatch(/^\d+\.\d+/)
  })

  it.each(['balanced', 'smaller'] as const)('compresses a PDF with the %s preset', async (preset) => {
    const input = fixture('document.pdf')

    const result = await compressor.compress(input, preset)

    expect(result).toMatchObject({ type: 'application/pdf', keptOriginal: false, width: null, height: null })
    expect(isPdf(result.data)).toBe(true)
    expect(result.data.length).toBeLessThan(input.length / 2)
  })

  it('makes smaller files with the smaller preset', async () => {
    const balanced = await compressor.compress(fixture('document.pdf'), 'balanced')
    const smaller = await compressor.compress(fixture('document.pdf'), 'smaller')

    expect(smaller.data.length).toBeLessThan(balanced.data.length)
  })

  it('keeps the original bytes when compression does not make the file smaller', async () => {
    const input = textOnlyPdf()

    const result = await compressor.compress(input, 'balanced')

    expect(result.keptOriginal).toBe(true)
    expect(result.data).toBe(input)
  })

  it('compresses a document whose cross-reference table needs repair', async () => {
    const input = fixture('document.pdf')
    const end = input.lastIndexOf('startxref')
    const broken = Buffer.concat([input.subarray(0, end), Buffer.from('startxref\n12345\n%%EOF\n')])

    const result = await compressor.compress(broken, 'balanced')

    expect(result.keptOriginal).toBe(false)
  })

  it('rejects a document that is missing content', async () => {
    const truncated = fixture('document.pdf').subarray(0, 50_000)

    await expect(compressor.compress(truncated, 'balanced')).rejects.toThrow(
      'The PDF file is damaged and cannot be compressed',
    )
  })

  it('rejects a file that only starts like a PDF', async () => {
    await expect(compressor.compress(Buffer.from('%PDF-1.4 not really'), 'balanced')).rejects.toThrow(
      'The file is not a valid PDF document',
    )
  })

  it('rejects a password-protected document', async () => {
    writeFileSync(join(scratch, 'plain.pdf'), fixture('document.pdf'))
    execFileSync(GHOSTSCRIPT_PATH, [
      '-q',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=pdfwrite',
      '-sOwnerPassword=owner',
      '-sUserPassword=user',
      `-sOutputFile=${join(scratch, 'locked.pdf')}`,
      join(scratch, 'plain.pdf'),
    ])

    await expect(compressor.compress(readFileSync(join(scratch, 'locked.pdf')), 'balanced')).rejects.toThrow(
      'Password-protected PDF files are not supported',
    )
  })

  it('gives up on a document that takes too long', async () => {
    const slow = new GhostscriptPdfCompressor(GHOSTSCRIPT_PATH, 1)

    await expect(slow.compress(fixture('document.pdf'), 'balanced')).rejects.toThrow(
      'The PDF file takes too long to compress',
    )
  })

  it('rejects a document above the size limit of PDF files', async () => {
    const padded = Buffer.concat([fixture('document.pdf'), Buffer.alloc(20 * 1024 * 1024)])

    await expect(compressor.compress(padded, 'balanced')).rejects.toThrow('The PDF file is too large')
  })

  it('fails with an ordinary error when Ghostscript cannot be started', async () => {
    const missing = new GhostscriptPdfCompressor(join(scratch, 'no-such-gs'))

    const error = await missing.compress(fixture('document.pdf'), 'balanced').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PermanentJobError)
  })
})

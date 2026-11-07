import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CompressionPreset, fileFormats } from '@onetodone/compress-shared'

import type { CompressedFile } from './compressed-file.js'
import { PermanentJobError } from './permanent-job-error.js'

const PDF = 'application/pdf'
const PDF_SIGNATURE = '%PDF-'

/**
 * Whether a file is a PDF document. Readers accept the signature anywhere in the first kilobyte,
 * after junk some generators write before it.
 */
export function isPdf(data: Buffer): boolean {
  return data.subarray(0, 1024).includes(PDF_SIGNATURE)
}

/** Compresses PDF documents. Injected by this class, so a worker without Ghostscript can refuse them. */
export abstract class PdfCompressor {
  /**
   * Compresses a PDF document into a PDF document.
   * @throws PermanentJobError when the document cannot be compressed
   */
  abstract compress(input: Buffer, preset: CompressionPreset): Promise<CompressedFile>
}

/** {@link PdfCompressor} of a worker without Ghostscript: every PDF fails. */
export class UnavailablePdfCompressor extends PdfCompressor {
  compress(): Promise<CompressedFile> {
    return Promise.reject(new PermanentJobError('PDF compression is not available'))
  }
}

/**
 * Longest a Ghostscript run may take. A task has to finish within the worker's stop timeout
 * (90 s on the server), with time left for downloading and storing the files.
 */
export const GHOSTSCRIPT_TIMEOUT_MS = 60_000

/**
 * Ghostscript options per preset. `/ebook` downsamples colour and grey images above 225 dpi to
 * 150 dpi and re-encodes them as JPEG; `smaller` goes down to 100 dpi.
 */
const PRESET_OPTIONS: Record<CompressionPreset, readonly string[]> = {
  balanced: ['-dPDFSETTINGS=/ebook'],
  smaller: ['-dPDFSETTINGS=/ebook', '-dColorImageResolution=100', '-dGrayImageResolution=100'],
}

const INVALID_PDF = 'The file is not a valid PDF document'

/** Ghostscript repairs a broken cross-reference table without losing content; other errors may lose some. */
const HARMLESS_ERROR = /xref|startxref/i

/** Compresses PDF documents by rewriting them with Ghostscript's `pdfwrite` device. */
export class GhostscriptPdfCompressor extends PdfCompressor {
  /**
   * @param path Ghostscript executable, e.g. `gs`
   * @param timeoutMs longest one run may take
   */
  constructor(
    private readonly path: string,
    private readonly timeoutMs = GHOSTSCRIPT_TIMEOUT_MS,
  ) {
    super()
  }

  /**
   * Returns the Ghostscript version.
   * @throws Error when the executable cannot be run
   */
  async version(): Promise<string> {
    return (await this.run(['--version'], process.cwd())).trim()
  }

  async compress(input: Buffer, preset: CompressionPreset): Promise<CompressedFile> {
    if (input.length > fileFormats.info(PDF).maxBytes) throw new PermanentJobError('The PDF file is too large')

    const dir = await mkdtemp(join(tmpdir(), 'compress-pdf-'))
    try {
      await writeFile(join(dir, 'input.pdf'), input)
      const output = await this.run(
        [
          // SAFER limits file access to the files named here; it is the default, set in case it is not.
          '-dSAFER',
          '-dBATCH',
          '-dNOPAUSE',
          '-dNOPROMPT',
          '-sDEVICE=pdfwrite',
          // pdfwrite would otherwise turn pages to match the direction of their text.
          '-dAutoRotatePages=/None',
          ...PRESET_OPTIONS[preset],
          '-sOutputFile=output.pdf',
          '-f',
          'input.pdf',
        ],
        dir,
      ).catch((error: unknown) => {
        if (error instanceof GhostscriptError) throw permanentError(error.output, error.message)
        throw error
      })
      checkOutput(output)

      const data = await readFile(join(dir, 'output.pdf'))
      if (!isPdf(data)) throw new PermanentJobError(INVALID_PDF, 'Ghostscript wrote no PDF')
      const keptOriginal = data.length >= input.length
      return { type: PDF, data: keptOriginal ? input : data, keptOriginal, width: null, height: null }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Runs Ghostscript and returns everything it printed. */
  private run(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.path,
        args,
        {
          cwd,
          // Nothing from the service's environment (secrets, GS_OPTIONS) reaches Ghostscript.
          env: { PATH: process.env.PATH ?? '' },
          timeout: this.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`
          if (!error) return resolve(output)
          // The executable is missing or cannot be started: a problem of the server, not of the file.
          if (typeof error.code === 'string') return reject(error)
          if (error.killed) return reject(new GhostscriptError('timeout', output))
          reject(new GhostscriptError(`exit code ${error.code ?? error.signal ?? 'unknown'}`, output))
        },
      )
    })
  }
}

/** Ghostscript ran and refused the file. */
class GhostscriptError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message)
  }
}

/**
 * Checks what Ghostscript printed for a run that exited normally. It exits with 0 for files it
 * cannot open and for files it had to skip content of, writing an empty or incomplete document.
 */
function checkOutput(output: string): void {
  // A file that cannot be opened ends with "No pages will be processed" instead.
  if (!/Processing pages \d+ through \d+/.test(output)) throw permanentError(output, 'no pages')
  const errors = reportedErrors(output)
  if (errors.some((error) => !HARMLESS_ERROR.test(error))) {
    throw new PermanentJobError('The PDF file is damaged and cannot be compressed', errors.join('; '))
  }
}

function permanentError(output: string, reason: string): PermanentJobError {
  if (/requires a password/i.test(output)) {
    return new PermanentJobError('Password-protected PDF files are not supported', reason)
  }
  if (reason === 'timeout') return new PermanentJobError('The PDF file takes too long to compress', reason)
  return new PermanentJobError(INVALID_PDF, [reason, ...reportedErrors(output)].join('; '))
}

/** The errors Ghostscript lists after processing a file it had to repair or skip parts of. */
function reportedErrors(output: string): string[] {
  const start = output.indexOf('The following errors were encountered')
  if (start < 0) return []
  const lines = output.slice(start).split('\n').slice(1)
  const errors: string[] = []
  for (const line of lines) {
    if (!line.startsWith('\t')) break
    errors.push(line.trim())
  }
  return errors
}

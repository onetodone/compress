import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CompressionPreset } from '@onetodone/compress-shared'
import sharp from 'sharp'

import { PermanentJobError } from './permanent-job-error.js'

/** An encoded image and its size in pixels. */
export interface EncodedImage {
  data: Buffer
  width: number
  height: number
}

/** Re-encodes HEIC images. Injected by this class, so a worker without the libheif tools can refuse them. */
export abstract class HeicEncoder {
  /**
   * Decodes an HEIC image and encodes it again as HEIC at the quality of the preset, without metadata.
   * @param input the HEIC file
   * @param maxPixels largest image to decode
   * @throws PermanentJobError when the image cannot be decoded
   */
  abstract encode(input: Buffer, preset: CompressionPreset, maxPixels: number): Promise<EncodedImage>
}

/** {@link HeicEncoder} of a worker without the libheif tools: every HEIC image fails. */
export class UnavailableHeicEncoder extends HeicEncoder {
  encode(): Promise<EncodedImage> {
    return Promise.reject(new PermanentJobError('HEIC compression is not available'))
  }
}

/**
 * Longest decoding and encoding one image may take together. A task has to finish within the
 * worker's stop timeout (90 s on the server), with time left for downloading and storing the files.
 */
export const HEIF_TIMEOUT_MS = 60_000

/** x265 quality per preset, on libheif's scale of 0 to 100. */
const QUALITY: Record<CompressionPreset, number> = { balanced: 50, smaller: 40 }

const INVALID_HEIC = 'The file is not a valid HEIC image'

/**
 * Re-encodes HEIC images with the command-line tools of libheif: `heif-dec` (libde265) decodes to
 * PNG, sharp strips metadata and converts to sRGB as for every other format, `heif-enc` (x265)
 * encodes the result.
 */
export class LibheifHeicEncoder extends HeicEncoder {
  /** Encodes run one after another: x265 uses every core and hundreds of MB on a large photo. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param dir directory with `heif-dec` and `heif-enc`, e.g. `/usr/bin`
   * @param timeoutMs longest decoding and encoding one image may take together
   */
  constructor(
    private readonly dir: string,
    private readonly timeoutMs = HEIF_TIMEOUT_MS,
  ) {
    super()
  }

  /**
   * Returns the libheif version after checking that the tools encode and decode a small HEIC image,
   * which needs their HEVC codec plugins.
   * @throws Error when a tool cannot be run or a codec plugin is missing
   */
  async check(): Promise<string> {
    const deadline = Date.now() + this.timeoutMs
    const version = (await this.run('heif-enc', ['--version'], process.cwd(), deadline)).trim().split('\n')[0]!
    const dir = await mkdtemp(join(tmpdir(), 'compress-heic-check-'))
    try {
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } })
        .png()
        .toFile(join(dir, 'sample.png'))
      await this.run('heif-enc', ['-o', 'sample.heic', 'sample.png'], dir, deadline).catch((error: unknown) => {
        throw new Error('heif-enc cannot encode HEIC images (libheif-plugin-x265)', { cause: error })
      })
      await this.run('heif-dec', ['sample.heic', 'decoded.png'], dir, deadline).catch((error: unknown) => {
        throw new Error('heif-dec cannot decode HEIC images (libheif-plugin-libde265)', { cause: error })
      })
      return version
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  encode(input: Buffer, preset: CompressionPreset, maxPixels: number): Promise<EncodedImage> {
    const result = this.queue.then(() => this.encodeNow(input, preset, maxPixels))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async encodeNow(input: Buffer, preset: CompressionPreset, maxPixels: number): Promise<EncodedImage> {
    const deadline = Date.now() + this.timeoutMs
    const dir = await mkdtemp(join(tmpdir(), 'compress-heic-'))
    try {
      await writeFile(join(dir, 'input.heic'), input)
      const decoded = await this.run('heif-dec', ['input.heic', 'decoded.png'], dir, deadline)
      // heif-dec exits with 0 for a truncated or damaged file and writes the parts it cannot decode as grey.
      const warnings = decoded.split('\n').filter((line) => line.startsWith('Warning:'))
      if (warnings.length > 0) {
        throw new PermanentJobError('The HEIC image is damaged and cannot be compressed', warnings.join('; '))
      }

      // libheif has already applied the rotation stored in the file; EXIF orientation must not apply again.
      const { width, height } = await sharp(join(dir, 'decoded.png'), { limitInputPixels: maxPixels })
        .png({ compressionLevel: 1 })
        .toFile(join(dir, 'clean.png'))
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : undefined
          if (detail?.includes('pixel limit')) throw new PermanentJobError('The image has too many pixels to process')
          throw new PermanentJobError(INVALID_HEIC, detail)
        })
      await this.run('heif-enc', ['-q', String(QUALITY[preset]), '-o', 'output.heic', 'clean.png'], dir, deadline)
      return { data: await readFile(join(dir, 'output.heic')), width, height }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * Runs one of the tools and returns everything it printed.
   * @throws PermanentJobError when the tool refuses the file or runs past the deadline
   * @throws Error when the tool cannot be started or was killed from outside, e.g. for lack of memory
   */
  private run(tool: 'heif-dec' | 'heif-enc', args: string[], cwd: string, deadline: number): Promise<string> {
    const timeout = deadline - Date.now()
    if (timeout <= 0) return Promise.reject(tooSlow())
    return new Promise((resolve, reject) => {
      execFile(
        join(this.dir, tool),
        args,
        {
          cwd,
          // Nothing from the service's environment (secrets, LIBHEIF_PLUGIN_PATH) reaches the tools.
          env: { PATH: process.env.PATH ?? '' },
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`
          if (!error) return resolve(output)
          if (typeof error.code === 'string') return reject(error)
          if (error.killed) return reject(tooSlow())
          if (error.signal) return reject(new Error(`${tool} was killed with ${error.signal}`))
          reject(new PermanentJobError(INVALID_HEIC, `${tool}: exit code ${error.code}; ${stderr.trim()}`))
        },
      )
    })
  }
}

function tooSlow(): PermanentJobError {
  return new PermanentJobError('The HEIC image takes too long to compress', 'timeout')
}

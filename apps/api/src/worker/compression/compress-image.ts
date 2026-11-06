import {
  type CompressionPreset,
  DEFAULT_COMPRESSION_PRESET,
  IMAGE_TYPES,
  imageFormats,
  type ImageType,
} from '@onetodone/compress-shared'
import sharp, { type Metadata, type Sharp } from 'sharp'

import { PermanentJobError } from './permanent-job-error.js'

/**
 * Largest image the worker decodes, in pixels. A small file can decode to a huge bitmap, so this
 * bounds memory per task (about 160 MB as RGBA).
 */
export const MAX_INPUT_PIXELS = 40_000_000

/** How the worker recognizes and re-encodes one image format. */
interface Codec {
  /** Whether sharp's metadata describes an image in this format. */
  matches(metadata: Metadata): boolean
  /** Re-encodes in this format. sharp drops all metadata on output unless asked to keep it. */
  encode(image: Sharp, preset: CompressionPreset): Sharp
}

/** Builds a codec whose encoder options are given per preset, so a preset without options does not compile. */
function codec<O>(definition: {
  matches: Codec['matches']
  presets: Record<CompressionPreset, O>
  encode: (image: Sharp, options: O) => Sharp
}): Codec {
  return {
    matches: definition.matches,
    encode: (image, preset) => definition.encode(image, definition.presets[preset]),
  }
}

/** One codec per supported format, so a format without an encoder does not compile. */
const CODECS: Record<ImageType, Codec> = {
  'image/jpeg': codec({
    matches: (metadata) => metadata.format === 'jpeg',
    presets: { balanced: { quality: 78 }, smaller: { quality: 65 } },
    encode: (image, options) => image.jpeg({ mozjpeg: true, ...options }),
  }),
  'image/png': codec({
    matches: (metadata) => metadata.format === 'png',
    // Palette quantization reaches its quality target with 256 colours on most images, so the
    // smaller preset also dithers less, which leaves longer runs for deflate.
    presets: { balanced: { quality: 80 }, smaller: { quality: 60, dither: 0.5 } },
    encode: (image, options) => image.png({ palette: true, compressionLevel: 9, ...options }),
  }),
  'image/webp': codec({
    matches: (metadata) => metadata.format === 'webp',
    presets: { balanced: { quality: 75 }, smaller: { quality: 60 } },
    encode: (image, options) => image.webp({ effort: 4, ...options }),
  }),
  'image/avif': codec({
    // libvips reads AVIF with its HEIF loader; other HEIF files (HEVC) are not supported.
    matches: (metadata) => metadata.format === 'heif' && metadata.compression === 'av1',
    presets: { balanced: { quality: 50 }, smaller: { quality: 40 } },
    // AV1 encoding is slow: effort 4 takes over ten times as long as effort 2 on a large photo,
    // and one task has to finish within the worker's stop timeout.
    encode: (image, options) => image.avif({ effort: 2, ...options }),
  }),
}

const INVALID_IMAGE = `The file is not a valid ${imageFormats.names('or')} image`

/** Outcome of {@link compressImage}. */
export interface CompressedImage {
  /** Type detected from the file content; the result has the same type. */
  type: ImageType
  /** Bytes to store as the result: the compressed image, or the original if compression did not help. */
  data: Buffer
  /** Whether `data` is the original because the compressed image was not smaller. */
  keptOriginal: boolean
  width: number
  height: number
}

/**
 * Compresses an image into the same format: applies the EXIF orientation, strips metadata and
 * re-encodes at the quality of the preset.
 *
 * @throws PermanentJobError when the input is not a decodable, still image of a supported format
 *   within the pixel limit
 */
export async function compressImage(
  input: Buffer,
  preset: CompressionPreset = DEFAULT_COMPRESSION_PRESET,
): Promise<CompressedImage> {
  const metadata = await sharp(input)
    .metadata()
    .catch(() => {
      throw new PermanentJobError(INVALID_IMAGE)
    })
  const type = IMAGE_TYPES.find((candidate) => CODECS[candidate].matches(metadata))
  if (!type) throw new PermanentJobError(`Only ${imageFormats.names('and')} images are supported`)
  // sharp reads only the first frame by default, so an animation would silently become a still image.
  if ((metadata.pages ?? 1) > 1) throw new PermanentJobError('Animated images are not supported')
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new PermanentJobError('The image has too many pixels to process')
  }

  const { data, info } = await CODECS[type]
    .encode(sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate(), preset)
    .toBuffer({ resolveWithObject: true })
    .catch(() => {
      throw new PermanentJobError(INVALID_IMAGE)
    })

  const keptOriginal = data.length >= input.length
  return { type, data: keptOriginal ? input : data, keptOriginal, width: info.width, height: info.height }
}

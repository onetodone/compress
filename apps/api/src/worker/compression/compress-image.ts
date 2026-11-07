import {
  type CompressionPreset,
  DEFAULT_COMPRESSION_PRESET,
  fileFormats,
  formatBytes,
  IMAGE_TYPES,
  type ImageType,
} from '@onetodone/compress-shared'
import sharp, { type Metadata, type Sharp } from 'sharp'

import { type EncodedImage, type HeicEncoder, UnavailableHeicEncoder } from './compress-heic.js'
import type { CompressedFile } from './compressed-file.js'
import { PermanentJobError } from './permanent-job-error.js'

/**
 * Largest image the worker decodes, in pixels. A small file can decode to a huge bitmap, so this
 * bounds memory per task (about 160 MB as RGBA).
 */
export const MAX_INPUT_PIXELS = 40_000_000

const INVALID_IMAGE = `The file is not a valid ${fileFormats.names('or', IMAGE_TYPES)} image`

/** How the worker recognizes and re-encodes one image format. */
interface Codec {
  /** Whether sharp's metadata describes an image in this format. */
  matches(metadata: Metadata): boolean
  /** Re-encodes in this format, without metadata. */
  encode(input: Buffer, preset: CompressionPreset, heic: HeicEncoder): Promise<EncodedImage>
}

/**
 * Builds a codec that re-encodes with sharp, whose encoder options are given per preset, so a
 * preset without options does not compile. sharp drops all metadata on output unless asked to keep it.
 */
function sharpCodec<O>(definition: {
  matches: Codec['matches']
  presets: Record<CompressionPreset, O>
  encode: (image: Sharp, options: O) => Sharp
}): Codec {
  return {
    matches: definition.matches,
    async encode(input, preset) {
      const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
      const { data, info } = await definition
        .encode(image, definition.presets[preset])
        .toBuffer({ resolveWithObject: true })
        .catch(() => {
          throw new PermanentJobError(INVALID_IMAGE)
        })
      return { data, width: info.width, height: info.height }
    },
  }
}

/** One codec per supported format, so a format without an encoder does not compile. */
const CODECS: Record<ImageType, Codec> = {
  'image/jpeg': sharpCodec({
    matches: (metadata) => metadata.format === 'jpeg',
    presets: { balanced: { quality: 78 }, smaller: { quality: 65 } },
    encode: (image, options) => image.jpeg({ mozjpeg: true, ...options }),
  }),
  'image/png': sharpCodec({
    matches: (metadata) => metadata.format === 'png',
    // Palette quantization reaches its quality target with 256 colours on most images, so the
    // smaller preset also dithers less, which leaves longer runs for deflate.
    presets: { balanced: { quality: 80 }, smaller: { quality: 60, dither: 0.5 } },
    encode: (image, options) => image.png({ palette: true, compressionLevel: 9, ...options }),
  }),
  'image/webp': sharpCodec({
    matches: (metadata) => metadata.format === 'webp',
    presets: { balanced: { quality: 75 }, smaller: { quality: 60 } },
    encode: (image, options) => image.webp({ effort: 4, ...options }),
  }),
  'image/avif': sharpCodec({
    // libvips reads AVIF with its HEIF loader, which reports HEIC (HEVC) files as `heif` too.
    matches: (metadata) => metadata.format === 'heif' && metadata.compression === 'av1',
    presets: { balanced: { quality: 50 }, smaller: { quality: 40 } },
    // AV1 encoding is slow: effort 4 takes over ten times as long as effort 2 on a large photo,
    // and one task has to finish within the worker's stop timeout.
    encode: (image, options) => image.avif({ effort: 2, ...options }),
  }),
  'image/heic': {
    // The prebuilt sharp reads the metadata of HEVC images but cannot decode or encode them.
    matches: (metadata) => metadata.format === 'heif' && metadata.compression === 'hevc',
    encode: (input, preset, heic) => heic.encode(input, preset, MAX_INPUT_PIXELS),
  },
}

/** Outcome of {@link compressImage}. */
export interface CompressedImage extends CompressedFile {
  type: ImageType
  width: number
  height: number
}

/**
 * Compresses an image into the same format: applies the EXIF orientation, strips metadata and
 * re-encodes at the quality of the preset.
 *
 * @param heic encoder of HEIC images; by default one that refuses them
 * @throws PermanentJobError when the input is not a decodable, still image of a supported format
 *   within the size and pixel limits
 */
export async function compressImage(
  input: Buffer,
  preset: CompressionPreset = DEFAULT_COMPRESSION_PRESET,
  heic: HeicEncoder = new UnavailableHeicEncoder(),
): Promise<CompressedImage> {
  const metadata = await sharp(input)
    .metadata()
    .catch(() => {
      throw new PermanentJobError(INVALID_IMAGE)
    })
  const type = IMAGE_TYPES.find((candidate) => CODECS[candidate].matches(metadata))
  if (!type) throw new PermanentJobError(`Only ${fileFormats.names('and')} files are supported`)
  // A file declared as another format may have been uploaded under a higher size limit.
  const { maxBytes } = fileFormats.info(type)
  if (input.length > maxBytes) throw new PermanentJobError(`The image must be at most ${formatBytes(maxBytes)}`)
  // sharp reads only the first frame by default, so an animation would silently become a still image.
  if ((metadata.pages ?? 1) > 1) throw new PermanentJobError('Animated images are not supported')
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new PermanentJobError('The image has too many pixels to process')
  }

  const { data, width, height } = await CODECS[type].encode(input, preset, heic)

  const keptOriginal = data.length >= input.length
  return { type, data: keptOriginal ? input : data, keptOriginal, width, height }
}

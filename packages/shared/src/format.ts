import { z } from 'zod'

/** How an image format is presented to users and named in files. */
export interface ImageFormatInfo {
  /** Name shown to users, e.g. `JPEG`. */
  name: string
  /** File extensions without the dot, lowercase; the first one is used for files the service writes. */
  extensions: readonly [string, ...string[]]
}

/** Everything derived from a set of image formats. */
export interface ImageFormatRegistry<T extends string> {
  /** MIME types of the formats, in registration order. */
  types: readonly [T, ...T[]]
  /** Validates one of the MIME types. */
  schema: z.ZodEnum<{ [K in T]: K }>
  /** Value for the `accept` attribute of a file input: every MIME type and extension. */
  accept: string
  /** Returns the format details of a MIME type. */
  info(type: T): ImageFormatInfo
  /** Returns the extension, without the dot, of files written in a format. */
  extension(type: T): string
  /** Returns the MIME type for a file extension (with or without the dot, any case), if it is known. */
  typeOfExtension(extension: string): T | undefined
  /** Removes the last extension of a file name if it belongs to any known format. */
  stripExtension(fileName: string): string
  /**
   * Lists the format names for running text, e.g. `JPEG, PNG and WebP`.
   * @param conjunction word before the last name
   */
  names(conjunction: 'and' | 'or'): string
}

/**
 * Builds the registry of a set of image formats. Every place that lists, validates or names image
 * formats derives from it, so a format is added by adding it here.
 * @param formats format details by MIME type
 */
export function defineImageFormats<T extends string>(formats: {
  readonly [K in T]: ImageFormatInfo
}): ImageFormatRegistry<T> {
  const types = Object.keys(formats) as T[]
  if (types.length === 0) throw new Error('At least one image format is required')
  const byExtension = new Map<string, T>()
  for (const type of types) {
    for (const extension of formats[type].extensions) byExtension.set(extension, type)
  }
  const extensions = [...byExtension.keys()]
  const names = types.map((type) => formats[type].name)

  return {
    types: types as [T, ...T[]],
    schema: z.enum(types as [T, ...T[]]) as unknown as z.ZodEnum<{ [K in T]: K }>,
    accept: [...types, ...extensions.map((extension) => `.${extension}`)].join(','),
    info: (type) => formats[type],
    extension: (type) => formats[type].extensions[0],
    typeOfExtension: (extension) => byExtension.get(extension.replace(/^\./, '').toLowerCase()),
    stripExtension(fileName) {
      const dot = fileName.lastIndexOf('.')
      if (dot <= 0 || !byExtension.has(fileName.slice(dot + 1).toLowerCase())) return fileName
      return fileName.slice(0, dot)
    },
    names: (conjunction) =>
      names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)!}`,
  }
}

/** The image formats the service compresses. The output of a job always has the format of its input. */
export const imageFormats = defineImageFormats({
  'image/jpeg': { name: 'JPEG', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  'image/png': { name: 'PNG', extensions: ['png'] },
  'image/webp': { name: 'WebP', extensions: ['webp'] },
  'image/avif': { name: 'AVIF', extensions: ['avif'] },
})

/** MIME type of a supported image format. */
export type ImageType = (typeof imageFormats.types)[number]

/** MIME types of the supported image formats. */
export const IMAGE_TYPES = imageFormats.types

/** Validates the MIME type of a supported image format. */
export const imageTypeSchema = imageFormats.schema

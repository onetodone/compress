import { z } from 'zod'

import { formatBytes } from './bytes.js'

/** What a file format holds: a single picture, or a document of pages. */
export type FileKind = 'image' | 'document'

/** How a file format is presented to users, named in files and limited in size. */
export interface FileFormatInfo {
  /** Name shown to users, e.g. `JPEG`. */
  name: string
  kind: FileKind
  /** File extensions without the dot, lowercase; the first one is used for files the service writes. */
  extensions: readonly [string, ...string[]]
  /** Largest file of this format the service accepts from anyone, in bytes. */
  maxBytes: number
}

/** The MIME types of a format table whose formats are of one kind. */
export type TypesOfKind<F extends Record<string, FileFormatInfo>, K extends FileKind> = {
  [T in keyof F & string]: F[T]['kind'] extends K ? T : never
}[keyof F & string]

/** Everything derived from a table of file formats. */
export interface FileFormatRegistry<F extends Record<string, FileFormatInfo>> {
  /** MIME types of the formats, in registration order. */
  types: readonly [keyof F & string, ...(keyof F & string)[]]
  /** Validates one of the MIME types. */
  schema: z.ZodEnum<{ [K in keyof F & string]: K }>
  /** Returns the format details of a MIME type. */
  info<T extends keyof F & string>(type: T): F[T]
  /** Returns the MIME types of the formats of one kind, in registration order. */
  ofKind<K extends FileKind>(kind: K): TypesOfKind<F, K>[]
  /**
   * Value for the `accept` attribute of a file input: every MIME type and extension.
   * @param types formats to accept; all of them by default
   */
  accept(types?: readonly (keyof F & string)[]): string
  /** Returns the extension, without the dot, of files written in a format. */
  extension(type: keyof F & string): string
  /** Returns the MIME type for a file extension (with or without the dot, any case), if it is known. */
  typeOfExtension(extension: string): (keyof F & string) | undefined
  /** Returns the MIME type for the extension of a file name, if it is known. */
  typeOfFileName(fileName: string): (keyof F & string) | undefined
  /** Removes the last extension of a file name if it belongs to any known format. */
  stripExtension(fileName: string): string
  /**
   * Lists the format names for running text, e.g. `JPEG, PNG and WebP`.
   * @param conjunction word before the last name
   * @param types formats to name; all of them by default
   */
  names(conjunction: 'and' | 'or', types?: readonly (keyof F & string)[]): string
}

/**
 * Builds the registry of a table of file formats. Every place that lists, validates, limits or names
 * file formats derives from it, so a format is added by adding it here.
 * @param formats format details by MIME type
 */
export function defineFileFormats<const F extends Record<string, FileFormatInfo>>(formats: F): FileFormatRegistry<F> {
  type T = keyof F & string
  const info = <K extends T>(type: K) => formats[type] as F[K]
  const types = Object.keys(formats) as T[]
  if (types.length === 0) throw new Error('At least one file format is required')
  const byExtension = new Map<string, T>()
  for (const type of types) {
    for (const extension of info(type).extensions) byExtension.set(extension, type)
  }
  const typeOfExtension = (extension: string) => byExtension.get(extension.replace(/^\./, '').toLowerCase())

  return {
    types: types as [T, ...T[]],
    schema: z.enum(types as [T, ...T[]]) as unknown as z.ZodEnum<{ [K in T]: K }>,
    info,
    ofKind: <K extends FileKind>(kind: K) => types.filter((type) => info(type).kind === kind) as TypesOfKind<F, K>[],
    accept(selected = types) {
      const extensions = selected.flatMap((type) => info(type).extensions.map((extension) => `.${extension}`))
      return [...selected, ...extensions].join(',')
    },
    extension: (type) => info(type).extensions[0],
    typeOfExtension,
    typeOfFileName(fileName) {
      const dot = fileName.lastIndexOf('.')
      return dot > 0 ? typeOfExtension(fileName.slice(dot + 1)) : undefined
    },
    stripExtension(fileName) {
      const dot = fileName.lastIndexOf('.')
      if (dot <= 0 || !byExtension.has(fileName.slice(dot + 1).toLowerCase())) return fileName
      return fileName.slice(0, dot)
    },
    names(conjunction, selected = types) {
      const names = selected.map((type) => info(type).name)
      if (names.length <= 1) return names[0] ?? ''
      return `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)!}`
    },
  }
}

const MB = 1024 * 1024

const FORMATS = {
  'image/jpeg': { name: 'JPEG', kind: 'image', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], maxBytes: 20 * MB },
  'image/png': { name: 'PNG', kind: 'image', extensions: ['png'], maxBytes: 20 * MB },
  'image/webp': { name: 'WebP', kind: 'image', extensions: ['webp'], maxBytes: 20 * MB },
  'image/avif': { name: 'AVIF', kind: 'image', extensions: ['avif'], maxBytes: 20 * MB },
  'application/pdf': { name: 'PDF', kind: 'document', extensions: ['pdf'], maxBytes: 20 * MB },
} as const satisfies Record<string, FileFormatInfo>

/**
 * The file formats the service compresses. The output of a job always has the format of its input.
 * A server can turn PDF compression off; the API then refuses PDF files.
 */
export const fileFormats = defineFileFormats(FORMATS)

/** MIME type of a supported file format. */
export type FileType = (typeof fileFormats.types)[number]

/** MIME types of the supported file formats. */
export const FILE_TYPES = fileFormats.types

/** Validates the MIME type of a supported file format. */
export const fileTypeSchema = fileFormats.schema

/** MIME type of a supported image format. */
export type ImageType = TypesOfKind<typeof FORMATS, 'image'>

/** MIME types of the supported image formats. */
export const IMAGE_TYPES: readonly ImageType[] = fileFormats.ofKind('image')

/** Whether a MIME type is one of the supported image formats. */
export function isImageType(type: string): type is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(type)
}

/** Largest file the API accepts from anyone, of any format, in bytes (20 MB). */
export const MAX_INPUT_BYTES = Math.max(...FILE_TYPES.map((type) => fileFormats.info(type).maxBytes))

/** Largest file a user may upload, in bytes, by MIME type. A type that is not listed is not accepted. */
export type InputLimits = Partial<Record<FileType, number>>

/**
 * Describes size limits for running text, e.g. `JPEG or PNG up to 10 MB each, PDF up to 20 MB`.
 * Formats with the same limit are named together, in registration order.
 * @param limits largest file by MIME type
 */
export function describeInputLimits(limits: InputLimits): string {
  const groups = new Map<number, FileType[]>()
  for (const type of FILE_TYPES) {
    const bytes = limits[type]
    if (bytes !== undefined) groups.set(bytes, [...(groups.get(bytes) ?? []), type])
  }
  return [...groups]
    .map(([bytes, types]) => {
      const each = types.length > 1 ? ' each' : ''
      return `${fileFormats.names('or', types)} up to ${formatBytes(bytes)}${each}`
    })
    .join(', ')
}

/**
 * Name of a downloaded result: the original name with any known extension replaced by that of the
 * result type.
 * @param originalName name of the uploaded file
 * @param type MIME type of the result
 */
export function downloadFileName(originalName: string, type: FileType): string {
  return `${fileFormats.stripExtension(originalName)}.${fileFormats.extension(type)}`
}

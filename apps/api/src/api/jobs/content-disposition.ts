import { type ImageType, imageFormats } from '@onetodone/image-compressor-shared'

/** Name of the downloaded result: the original name with any image extension replaced by that of the result type. */
export function downloadFileName(originalName: string, type: ImageType): string {
  return `${imageFormats.stripExtension(originalName)}.${imageFormats.extension(type)}`
}

/**
 * `Content-Disposition` value that makes browsers save (`attachment`) or display (`inline`) the file,
 * named `fileName`. Browsers that understand RFC 6266 use the UTF-8 `filename*`; the others get an
 * ASCII-only `filename`.
 */
export function contentDisposition(disposition: 'attachment' | 'inline', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

import type { FileType } from '@onetodone/compress-shared'

/** A compressed file, ready to be stored as the result of a job. */
export interface CompressedFile {
  /** Type detected from the file content; the result has the same type. */
  type: FileType
  /** Bytes to store as the result: the compressed file, or the original if compression did not help. */
  data: Buffer
  /** Whether `data` is the original because the compressed file was not smaller. */
  keptOriginal: boolean
  /** Size of an image in pixels; `null` for documents. */
  width: number | null
  height: number | null
}

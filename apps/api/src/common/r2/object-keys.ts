import { type ImageType, imageFormats } from '@onetodone/compress-shared'

/** R2 key of the original image uploaded for a job. */
export function originalKey(uid: string, jobId: string): string {
  return `originals/${uid}/${jobId}`
}

/** R2 key of the compressed result of a job, with the extension of its image type. */
export function resultKey(uid: string, jobId: string, type: ImageType): string {
  return `results/${uid}/${jobId}.${imageFormats.extension(type)}`
}

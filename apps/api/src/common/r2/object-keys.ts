import { fileFormats, type FileType } from '@onetodone/compress-shared'

/** R2 key of the original file uploaded for a job. */
export function originalKey(uid: string, jobId: string): string {
  return `originals/${uid}/${jobId}`
}

/** R2 key of the compressed result of a job, with the extension of its file type. */
export function resultKey(uid: string, jobId: string, type: FileType): string {
  return `results/${uid}/${jobId}.${fileFormats.extension(type)}`
}

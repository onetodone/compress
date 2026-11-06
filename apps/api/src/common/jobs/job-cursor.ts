import { jobIdSchema } from '@onetodone/image-compressor-shared'
import { Timestamp } from 'firebase-admin/firestore'

/** Position after which the next page of a user's jobs starts. */
export interface JobCursor {
  createdAt: Timestamp
  id: string
}

/**
 * Encodes the position of a job in the newest-first job list. Nanoseconds are kept, so jobs created
 * in the same millisecond are neither skipped nor repeated, and the position stays valid after the
 * job itself is deleted.
 */
export function encodeJobCursor(cursor: JobCursor): string {
  const { seconds, nanoseconds } = cursor.createdAt
  return Buffer.from(`${seconds}.${nanoseconds}.${cursor.id}`).toString('base64url')
}

/** Decodes a cursor made by {@link encodeJobCursor}; returns `null` for anything else. */
export function decodeJobCursor(value: string): JobCursor | null {
  const match = /^(\d{1,12})\.(\d{1,9})\.(.+)$/.exec(Buffer.from(value, 'base64url').toString())
  if (!match || !jobIdSchema.safeParse(match[3]).success) return null
  return { createdAt: new Timestamp(Number(match[1]), Number(match[2])), id: match[3]! }
}

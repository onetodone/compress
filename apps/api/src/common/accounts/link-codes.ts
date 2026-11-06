import { createHash, randomBytes } from 'node:crypto'

import { linkCodeSchema } from '@onetodone/compress-shared'

/** Firestore collection of one-time codes, stored under the hash of the code. */
export const LINK_CODES = 'linkCodes'

/** How long a code can be used. */
export const LINK_CODE_LIFETIME_MS = 10 * 60_000

/** What a code does: `link` connects a Telegram account to a website user, `login` signs in on the website. */
export type LinkCodePurpose = 'link' | 'login'

/** A code as stored in `linkCodes`. */
export interface StoredLinkCode {
  purpose: LinkCodePurpose
  /** User the code was created for. */
  uid: string
  /** Telegram account that asked for a login code; `null` for `link` codes. */
  telegramId: number | null
  /** How the bot names the website account of a `link` code, e.g. its email; `null` if unknown. */
  label: string | null
  expiresAt: Date
}

/** Returns a fresh random code: 16 bytes, base64url. */
export function newLinkCode(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Returns the document id of a code: its SHA-256 hash, so whoever can read the collection or its
 * paths in logs cannot use the codes.
 */
export function linkCodeId(code: string): string {
  return createHash('sha256').update(code).digest('base64url')
}

/** Whether a string has the form of a code; anything else is refused without a database read. */
export function isLinkCode(value: string): boolean {
  return linkCodeSchema.safeParse(value).success
}

/**
 * Reads a stored code, or `null` when it is missing, malformed, made for another purpose or expired.
 * @param data the document's data
 */
export function readLinkCode(
  data: Record<string, unknown> | undefined,
  purpose: LinkCodePurpose,
  now: Date,
): StoredLinkCode | null {
  if (!data || data.purpose !== purpose || typeof data.uid !== 'string') return null
  const expiresAt = toDate(data.expiresAt)
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return null
  const telegramId = typeof data.telegramId === 'number' ? data.telegramId : null
  if (purpose === 'login' && telegramId === null) return null
  const label = typeof data.label === 'string' ? data.label : null
  return { purpose, uid: data.uid, telegramId, label, expiresAt }
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function') {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

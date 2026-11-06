/** Replacement for every masked value. */
export const REDACTED = '[REDACTED]'

const SENSITIVE_KEY = /authorization|cookie|token|secret|password|signature|credential|api[-_]?key|private[-_]?key/i

const STRING_RULES: [RegExp, string][] = [
  [/([?&]X-Amz-(?:Signature|Credential|Security-Token)=)[^&#\s"']*/gi, `$1${REDACTED}`],
  [/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, REDACTED],
  [/(cloudinary:\/\/)[^@\s]+@/gi, `$1${REDACTED}@`],
  // A Telegram bot token is part of every Bot API URL, e.g. /bot123456:ABC-def/getMe.
  [/\d{5,}:[\w-]{30,}/g, REDACTED],
]

const MAX_DEPTH = 8

/** Masks presigned URL signatures, bearer tokens, JWTs, bot tokens and credentials embedded in a string. */
export function maskString(value: string): string {
  return STRING_RULES.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), value)
}

/**
 * Returns a copy of a log value with sensitive data masked: values under keys that look like
 * credentials are replaced entirely, every other string goes through {@link maskString}.
 */
export function maskSensitive(value: unknown): unknown {
  return mask(value, 0, new WeakSet())
}

function mask(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return maskString(value)
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value) || depth >= MAX_DEPTH) return '[Truncated]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => mask(item, depth + 1, seen))

  const source: Record<string, unknown> =
    value instanceof Error ? { ...value, type: value.name, message: value.message, stack: value.stack } : { ...value }

  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) && item != null ? REDACTED : mask(item, depth + 1, seen),
    ]),
  )
}

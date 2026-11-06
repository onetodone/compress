import { type AccountKind, type QuotaErrorCode, quotaErrorCodeSchema } from '@onetodone/compress-shared'

/**
 * Returns the message for a refused job.
 * @param code limit that was reached
 * @param kind account kind of the user; signing in raises the limit of an anonymous one
 */
export function quotaLimitMessage(code: QuotaErrorCode, kind: AccountKind): string {
  if (code === 'network_daily_limit') return 'Too many images from your network today. Sign in to continue.'
  return kind === 'anonymous'
    ? 'Daily limit reached. Sign in for more, or try again tomorrow.'
    : 'Daily limit reached. Try again tomorrow.'
}

function quotaErrorCode(body: unknown): QuotaErrorCode {
  const code = quotaErrorCodeSchema.safeParse(
    typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined,
  )
  return code.success ? code.data : 'daily_limit'
}

/** An API request that failed; `message` is safe to show to the user. */
export class ApiError extends Error {
  /**
   * @param status HTTP status code, `0` when the server could not be reached
   * @param quotaCode the limit that refused the request, for a `429`
   */
  constructor(
    readonly status: number,
    message: string,
    readonly quotaCode: QuotaErrorCode | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Builds the error of a failed API response.
 * @param status HTTP status code
 * @param body parsed JSON body, if any
 */
export function apiError(status: number, body: unknown): ApiError {
  return new ApiError(status, apiErrorMessage(status, body), status === 429 ? quotaErrorCode(body) : null)
}

/**
 * Returns a user-facing message for a failed API response.
 * @param status HTTP status code
 * @param body parsed JSON body, if any
 */
export function apiErrorMessage(status: number, body: unknown): string {
  if (status === 429) return quotaLimitMessage(quotaErrorCode(body), 'registered')
  if (status === 401) return 'Your session expired. Reload the page.'
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined
  // The API only puts user-safe text into 4xx messages; 5xx details are never shown.
  if (status < 500 && typeof message === 'string') return message
  return 'Something went wrong. Try again.'
}

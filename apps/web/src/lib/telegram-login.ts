import { linkCodeSchema, TELEGRAM_LOGIN_FRAGMENT } from '@onetodone/compress-shared'

/**
 * Returns the login code a Telegram bot link carries in the URL fragment (`#telegram-login=<code>`),
 * or `null` when there is none or it is malformed.
 * @param hash `location.hash`, with or without the leading `#`
 */
export function loginCodeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, '')).get(TELEGRAM_LOGIN_FRAGMENT)
  return code !== null && linkCodeSchema.safeParse(code).success ? code : null
}

/**
 * Takes the login code out of the current URL, so a reload or a shared address does not carry it.
 * Returns the code, or `null` when the URL has none.
 */
export function takeLoginCode(): string | null {
  const code = loginCodeFromHash(window.location.hash)
  if (new URLSearchParams(window.location.hash.replace(/^#/, '')).has(TELEGRAM_LOGIN_FRAGMENT)) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  return code
}

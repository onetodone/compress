/** Firestore collection of per-user documents: quota counters and account links. */
export const USERS = 'users'

/** What `users/{uid}` records about the ways into an account. */
export interface AccountLinks {
  /** Id of the linked Telegram account, if any. */
  telegramId: number | null
  /** Username of the linked Telegram account when it was linked, if it had one. */
  telegramUsername: string | null
  /** Whether a Google sign-in is linked, as last seen in a verified ID token of the user. */
  googleLinked: boolean
}

/** Reads the account links from a `users/{uid}` document, ignoring missing or malformed fields. */
export function readAccountLinks(data: Record<string, unknown> | undefined): AccountLinks {
  const telegramId = data?.telegramId
  const telegramUsername = data?.telegramUsername
  return {
    telegramId: typeof telegramId === 'number' ? telegramId : null,
    telegramUsername: typeof telegramUsername === 'string' ? telegramUsername : null,
    googleLinked: data?.googleLinked === true,
  }
}

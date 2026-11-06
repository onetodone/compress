import type { AccountKind } from '@onetodone/compress-shared'

/** The user a request or a job acts for. */
export interface AuthUser {
  uid: string
  kind: AccountKind
  /** Email of the verified ID token, when it has one (e.g. a Google sign-in). */
  email?: string
}

/**
 * Returns the account kind of a verified Firebase ID token.
 * @param signInProvider the token's `firebase.sign_in_provider`, e.g. `anonymous`, `google.com` or `custom`
 */
export function accountKindOf(signInProvider: string): AccountKind {
  return signInProvider === 'anonymous' ? 'anonymous' : 'registered'
}

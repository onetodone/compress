import { FirebaseError } from 'firebase/app'
import {
  type Auth,
  GoogleAuthProvider,
  linkWithPopup,
  signOut as firebaseSignOut,
  signInWithCredential,
  signInWithPopup,
  type User,
} from 'firebase/auth'

/**
 * How a Google sign-in ended: `linked` kept the anonymous uid, `switched` signed in to an account
 * that already existed, `cancelled` means the user closed the popup.
 */
export type GoogleSignInOutcome = 'linked' | 'switched' | 'cancelled'

/** A sign-in that failed; `message` is safe to show to the user. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignInError'
  }
}

const CANCELLED_CODES = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'])

/**
 * Returns a user-facing message for a failed sign-in, or `null` when the user cancelled it.
 * @param code Firebase Auth error code, e.g. `auth/popup-blocked`
 */
export function signInErrorMessage(code: string): string | null {
  if (CANCELLED_CODES.has(code)) return null
  if (code === 'auth/popup-blocked') return 'The sign-in window was blocked. Allow popups for this site and try again.'
  if (code === 'auth/network-request-failed') return 'Cannot reach Google. Check your connection.'
  return 'Could not sign in. Try again.'
}

const GOOGLE_PROVIDER = GoogleAuthProvider.PROVIDER_ID

function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  return provider
}

/** Whether a Firebase user can sign in with Google. */
export function hasGoogle(user: User): boolean {
  return user.providerData.some((provider) => provider.providerId === GOOGLE_PROVIDER)
}

/**
 * Signs in with Google. A user without Google (anonymous, or signed in through Telegram) is linked,
 * so uid, history and quota stay the same. When the Google account already belongs to another user,
 * signs in to that user instead; an anonymous session left that way hands its images and used quota
 * to that user through `mergeAnonymous`, a Telegram one stays reachable through the bot and keeps them.
 *
 * @param mergeAnonymous moves the images of the anonymous session left behind, given its ID token
 * @throws SignInError when sign-in fails for a reason other than the user closing the popup
 */
export async function signInWithGoogle(
  auth: Auth,
  mergeAnonymous: (anonymousToken: string) => Promise<void> = async () => {},
): Promise<GoogleSignInOutcome> {
  const user = auth.currentUser
  try {
    if (user && !hasGoogle(user)) {
      await linkWithPopup(user, googleProvider())
      // The API reads the sign-in provider from the token, so the next request must carry a fresh one.
      await user.getIdToken(true)
      return 'linked'
    }
    await signInWithPopup(auth, googleProvider())
    return 'switched'
  } catch (error) {
    if (error instanceof FirebaseError && error.code === 'auth/credential-already-in-use') {
      return signInToExistingAccount(auth, error, mergeAnonymous)
    }
    return failed(error)
  }
}

async function signInToExistingAccount(
  auth: Auth,
  error: FirebaseError,
  mergeAnonymous: (anonymousToken: string) => Promise<void>,
): Promise<GoogleSignInOutcome> {
  const credential = GoogleAuthProvider.credentialFromError(error)
  if (!credential) return failed(error)
  const anonymousToken = await anonymousSessionToken(auth)
  try {
    await signInWithCredential(auth, credential)
    if (anonymousToken) await mergeAnonymous(anonymousToken)
    return 'switched'
  } catch (signInError) {
    return failed(signInError)
  }
}

/**
 * Returns the ID token of the current session when it is anonymous, to merge it into the account
 * signed in next; `null` for other sessions or when the token cannot be read.
 */
export async function anonymousSessionToken(auth: Auth): Promise<string | null> {
  const user = auth.currentUser
  if (!user?.isAnonymous) return null
  return user.getIdToken().catch(() => null)
}

function failed(error: unknown): GoogleSignInOutcome {
  const message = signInErrorMessage(error instanceof FirebaseError ? error.code : '')
  if (message === null) return 'cancelled'
  throw new SignInError(message)
}

/** Signs out; the session hook then starts a fresh anonymous session. */
export function signOut(auth: Auth): Promise<void> {
  return firebaseSignOut(auth)
}

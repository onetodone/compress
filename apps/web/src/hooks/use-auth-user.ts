'use client'

import type { AccountKind } from '@onetodone/compress-shared'
import { type Auth, onIdTokenChanged, signInAnonymously, signInWithCustomToken, type User } from 'firebase/auth'
import { useCallback, useEffect, useRef, useState } from 'react'

import { anonymousSessionToken, type GoogleSignInOutcome, hasGoogle, signInWithGoogle, signOut } from '@/lib/account'
import { ApiError } from '@/lib/api-error'
import { getFirebase } from '@/lib/firebase'
import { api } from '@/lib/api'
import { takeLoginCode } from '@/lib/telegram-login'

/** The parts of the Firebase user the UI renders. */
export interface SessionUser {
  uid: string
  kind: AccountKind
  /** Display name, or email when there is none; `null` for anonymous users and Telegram sign-ins. */
  name: string | null
  /** Whether the user can sign in with Google. */
  hasGoogle: boolean
}

/**
 * A sign-in with a Telegram login link: `confirm` waits for the user to agree to leave the account
 * they are signed in to (`account`) or to move the images of their anonymous session to the Telegram
 * account (`images`), `signing_in` is in progress, `failed` carries a message for the user.
 */
export type TelegramLoginState =
  | { status: 'confirm'; leaving: 'account' | 'images' }
  | { status: 'signing_in' }
  | { status: 'failed'; message: string }

/** The current session, why none could be started, and the actions that change it. */
export interface AuthState {
  user: SessionUser | null
  error: string | null
  /** A sign-in with a Telegram login link from the URL, if the page was opened with one. */
  telegramLogin: TelegramLoginState | null
  /**
   * Signs in with Google, linking a user who has no Google sign-in yet.
   * @throws SignInError with a user-facing message
   */
  signInWithGoogle: () => Promise<GoogleSignInOutcome>
  /** Signs out and starts a fresh anonymous session. */
  signOut: () => Promise<void>
  /** Goes ahead with a Telegram login that waits for confirmation. */
  confirmTelegramLogin: () => void
  /** Drops a Telegram login that waits for confirmation or has failed. */
  dismissTelegramLogin: () => void
}

function toSessionUser(user: User): SessionUser {
  return {
    uid: user.uid,
    kind: user.isAnonymous ? 'anonymous' : 'registered',
    name: user.isAnonymous ? null : (user.displayName ?? user.email),
    hasGoogle: hasGoogle(user),
  }
}

/**
 * Returns the current Firebase user and signs in anonymously when there is none. A page opened with
 * a Telegram login link signs in as that Telegram account instead; when another registered account
 * is signed in, it asks first. An anonymous session left for another account hands its images and
 * used quota to that account before the new user is returned.
 */
export function useAuthUser(): AuthState {
  const [state, setState] = useState<Pick<AuthState, 'user' | 'error'>>({ user: null, error: null })
  const [telegramLogin, setTelegramLogin] = useState<TelegramLoginState | null>(null)
  const pendingCode = useRef<string | null>(null)
  // While a login code is exchanged, a missing session must not start an anonymous one.
  const exchanging = useRef(false)
  // While a sign-in may still merge the anonymous session it leaves, the new user is not shown yet,
  // so the history loads once the merged images belong to it.
  const holding = useRef(false)

  const exchange = useCallback(async (auth: Auth, code: string) => {
    exchanging.current = true
    setTelegramLogin({ status: 'signing_in' })
    holding.current = true
    try {
      const anonymousToken = await anonymousSessionToken(auth)
      // The code works once; the first sign-in with its token creates the Firebase user.
      const { customToken } = await api.telegramLogin(code)
      await signInWithCustomToken(auth, customToken)
      if (anonymousToken) await mergeAnonymousSession(anonymousToken)
      setTelegramLogin(null)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not sign in with Telegram. Try again.'
      setTelegramLogin({ status: 'failed', message })
    } finally {
      exchanging.current = false
      holding.current = false
      if (auth.currentUser) setState({ user: toSessionUser(auth.currentUser), error: null })
      else startAnonymousSession(auth, setState)
    }
  }, [])

  useEffect(() => {
    const { auth } = getFirebase()
    const code = takeLoginCode()
    if (code) {
      exchanging.current = true
      void auth.authStateReady().then(async () => {
        const leaving = await leavingWith(auth.currentUser)
        if (leaving) {
          exchanging.current = false
          pendingCode.current = code
          setTelegramLogin({ status: 'confirm', leaving })
          return
        }
        void exchange(auth, code)
      })
    }
    // Linking keeps the same user object and does not fire onAuthStateChanged; the token changes, though.
    return onIdTokenChanged(auth, (user) => {
      if (user) {
        if (!holding.current) setState({ user: toSessionUser(user), error: null })
        return
      }
      setState({ user: null, error: null })
      if (!exchanging.current) startAnonymousSession(auth, setState)
    })
  }, [exchange])

  const google = useCallback(async () => {
    const { auth } = getFirebase()
    holding.current = true
    try {
      return await signInWithGoogle(auth, mergeAnonymousSession)
    } finally {
      holding.current = false
      if (auth.currentUser) setState({ user: toSessionUser(auth.currentUser), error: null })
    }
  }, [])

  const out = useCallback(() => signOut(getFirebase().auth), [])

  const confirmTelegramLogin = useCallback(() => {
    const code = pendingCode.current
    pendingCode.current = null
    if (code) void exchange(getFirebase().auth, code)
  }, [exchange])

  const dismissTelegramLogin = useCallback(() => {
    pendingCode.current = null
    setTelegramLogin(null)
  }, [])

  return {
    ...state,
    telegramLogin,
    signInWithGoogle: google,
    signOut: out,
    confirmTelegramLogin,
    dismissTelegramLogin,
  }
}

/**
 * What a Telegram login would leave behind and must be confirmed: another registered account, or the
 * images of an anonymous session, which move to the Telegram account. A login link can come from
 * someone else, so neither happens without asking. `null` when there is nothing to lose.
 */
async function leavingWith(current: User | null): Promise<'account' | 'images' | null> {
  if (!current) return null
  if (!current.isAnonymous) return 'account'
  const hasImages = await api.listJobs(null).then(
    (page) => page.jobs.length > 0,
    () => true,
  )
  return hasImages ? 'images' : null
}

/**
 * Moves the images of an anonymous session that was just left into the signed-in user. A failure
 * leaves them behind but does not undo the sign-in.
 */
async function mergeAnonymousSession(anonymousToken: string): Promise<void> {
  await api.mergeAnonymousSession(anonymousToken).catch(() => undefined)
}

function startAnonymousSession(auth: Auth, setState: (state: Pick<AuthState, 'user' | 'error'>) => void): void {
  signInAnonymously(auth).catch(() => setState({ user: null, error: 'Could not start a session. Reload the page.' }))
}

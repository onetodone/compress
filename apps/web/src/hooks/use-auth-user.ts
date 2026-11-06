'use client'

import type { AccountKind } from '@onetodone/compress-shared'
import { type Auth, onIdTokenChanged, signInAnonymously, signInWithCustomToken, type User } from 'firebase/auth'
import { useCallback, useEffect, useRef, useState } from 'react'

import { type GoogleSignInOutcome, hasGoogle, signInWithGoogle, signOut } from '@/lib/account'
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
 * A sign-in with a Telegram login link: `confirm` waits for the user to leave the account they are
 * signed in to, `signing_in` is in progress, `failed` carries a message for the user.
 */
export type TelegramLoginState =
  { status: 'confirm' } | { status: 'signing_in' } | { status: 'failed'; message: string }

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
 * is signed in, it asks first.
 */
export function useAuthUser(): AuthState {
  const [state, setState] = useState<Pick<AuthState, 'user' | 'error'>>({ user: null, error: null })
  const [telegramLogin, setTelegramLogin] = useState<TelegramLoginState | null>(null)
  const pendingCode = useRef<string | null>(null)
  // While a login code is exchanged, a missing session must not start an anonymous one.
  const exchanging = useRef(false)

  const exchange = useCallback(async (auth: Auth, code: string) => {
    exchanging.current = true
    setTelegramLogin({ status: 'signing_in' })
    try {
      // The code works once; the first sign-in with its token creates the Firebase user.
      const { customToken } = await api.telegramLogin(code)
      await signInWithCustomToken(auth, customToken)
      setTelegramLogin(null)
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not sign in with Telegram. Try again.'
      setTelegramLogin({ status: 'failed', message })
    } finally {
      exchanging.current = false
      if (!auth.currentUser) startAnonymousSession(auth, setState)
    }
  }, [])

  useEffect(() => {
    const { auth } = getFirebase()
    const code = takeLoginCode()
    if (code) {
      exchanging.current = true
      void auth.authStateReady().then(() => {
        const current = auth.currentUser
        if (current && !current.isAnonymous) {
          exchanging.current = false
          pendingCode.current = code
          setTelegramLogin({ status: 'confirm' })
          return
        }
        void exchange(auth, code)
      })
    }
    // Linking keeps the same user object and does not fire onAuthStateChanged; the token changes, though.
    return onIdTokenChanged(auth, (user) => {
      if (user) {
        setState({ user: toSessionUser(user), error: null })
        return
      }
      setState({ user: null, error: null })
      if (!exchanging.current) startAnonymousSession(auth, setState)
    })
  }, [exchange])

  const google = useCallback(async () => {
    const { auth } = getFirebase()
    const outcome = await signInWithGoogle(auth)
    if (auth.currentUser) setState({ user: toSessionUser(auth.currentUser), error: null })
    return outcome
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

function startAnonymousSession(auth: Auth, setState: (state: Pick<AuthState, 'user' | 'error'>) => void): void {
  signInAnonymously(auth).catch(() => setState({ user: null, error: 'Could not start a session. Reload the page.' }))
}

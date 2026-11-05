'use client'

import { onIdTokenChanged, signInAnonymously, type User } from 'firebase/auth'
import { useCallback, useEffect, useState } from 'react'

import { type GoogleSignInOutcome, signInWithGoogle, signOut } from '@/lib/account'
import { getFirebase } from '@/lib/firebase'

/** The parts of the Firebase user the UI renders. */
export interface SessionUser {
  uid: string
  isAnonymous: boolean
  /** Display name, or email when there is none; `null` for anonymous users. */
  name: string | null
}

/** The current session, why none could be started, and the actions that change it. */
export interface AuthState {
  user: SessionUser | null
  error: string | null
  /**
   * Signs in with Google, linking an anonymous user.
   * @throws SignInError with a user-facing message
   */
  signInWithGoogle: () => Promise<GoogleSignInOutcome>
  /** Signs out and starts a fresh anonymous session. */
  signOut: () => Promise<void>
}

function toSessionUser(user: User): SessionUser {
  return {
    uid: user.uid,
    isAnonymous: user.isAnonymous,
    name: user.isAnonymous ? null : (user.displayName ?? user.email),
  }
}

/** Returns the current Firebase user and signs in anonymously when there is none. */
export function useAuthUser(): AuthState {
  const [state, setState] = useState<Pick<AuthState, 'user' | 'error'>>({ user: null, error: null })

  useEffect(() => {
    const { auth } = getFirebase()
    // Linking keeps the same user object and does not fire onAuthStateChanged; the token changes, though.
    return onIdTokenChanged(auth, (user) => {
      if (user) {
        setState({ user: toSessionUser(user), error: null })
        return
      }
      setState({ user: null, error: null })
      signInAnonymously(auth).catch(() =>
        setState({ user: null, error: 'Could not start a session. Reload the page.' }),
      )
    })
  }, [])

  const google = useCallback(async () => {
    const { auth } = getFirebase()
    const outcome = await signInWithGoogle(auth)
    if (auth.currentUser) setState({ user: toSessionUser(auth.currentUser), error: null })
    return outcome
  }, [])

  const out = useCallback(() => signOut(getFirebase().auth), [])

  return { ...state, signInWithGoogle: google, signOut: out }
}

'use client'

import { useState } from 'react'

import type { AuthState, SessionUser } from '@/hooks/use-auth-user'
import { SignInError } from '@/lib/account'

interface AccountControlProps {
  user: SessionUser
  signInWithGoogle: AuthState['signInWithGoogle']
  signOut: AuthState['signOut']
}

const BUTTON =
  'rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900'

export function AccountControl({ user, signInWithGoogle, signOut }: AccountControlProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof SignInError ? caught.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1 text-sm">
      {user.kind === 'anonymous' ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-zinc-600 dark:text-zinc-400">Sign in for more images a day</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(signInWithGoogle, 'Could not sign in. Try again.')}
            className={BUTTON}
          >
            Sign in with Google
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {user.name && <span className="max-w-56 truncate text-zinc-600 dark:text-zinc-400">{user.name}</span>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(signOut, 'Could not sign out. Try again.')}
            className={BUTTON}
          >
            Sign out
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

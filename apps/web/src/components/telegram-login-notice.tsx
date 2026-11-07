'use client'

import type { TelegramLoginState } from '@/hooks/use-auth-user'

interface TelegramLoginNoticeProps {
  state: TelegramLoginState
  /** Name of the account currently signed in, if known. */
  currentName: string | null
  onConfirm: () => void
  onDismiss: () => void
}

const BUTTON =
  'rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900'

/** Progress, confirmation or failure of a sign-in with a Telegram login link. */
export function TelegramLoginNotice({ state, currentName, onConfirm, onDismiss }: TelegramLoginNoticeProps) {
  if (state.status === 'signing_in') {
    return (
      <p role="status" className="rounded-lg bg-zinc-100 px-4 py-3 text-sm dark:bg-zinc-900">
        Signing in with Telegram…
      </p>
    )
  }

  if (state.status === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      >
        <span>{state.message}</span>
        <button type="button" onClick={onDismiss} className={BUTTON}>
          Close
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-zinc-100 px-4 py-3 text-sm dark:bg-zinc-900">
      {state.leaving === 'images' ? (
        <span>
          Sign in with your Telegram account? The files of this session move to it. Continue only with a link from your
          own Telegram.
        </span>
      ) : (
        <span>
          Sign in with your Telegram account? You will leave the account you are signed in to
          {currentName ? ` (${currentName})` : ''}. To use both together, choose “Connect Telegram” instead.
        </span>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onConfirm} className={BUTTON}>
          Sign in with Telegram
        </button>
        <button type="button" onClick={onDismiss} className={BUTTON}>
          Stay
        </button>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'

import { useTelegramLink } from '@/hooks/use-telegram-link'
import { ApiError } from '@/lib/api-error'

interface TelegramLinkProps {
  uid: string
  hasGoogle: boolean
}

const BUTTON =
  'rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900'

/** Shows the linked Telegram account of a registered user, and connects or disconnects one. */
export function TelegramLink({ uid, hasGoogle }: TelegramLinkProps) {
  const { status, connect, disconnect } = useTelegramLink(uid, hasGoogle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<{ url: string; expiresAt: Date } | null>(null)

  // The code stops working at its expiry; then the button asks for a new one.
  useEffect(() => {
    if (!link) return
    const timer = setTimeout(() => setLink(null), Math.max(link.expiresAt.getTime() - Date.now(), 0))
    return () => clearTimeout(timer)
  }, [link])

  if (!status) return null

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const account = status.username ? `@${status.username}` : 'connected'

  return (
    <div className="flex flex-col items-end gap-1 text-sm">
      {status.linked ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-zinc-600 dark:text-zinc-400">Telegram: {account}</span>
          {hasGoogle && (
            <button type="button" disabled={busy} onClick={() => void run(disconnect)} className={BUTTON}>
              Disconnect
            </button>
          )}
        </div>
      ) : link ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-zinc-600 dark:text-zinc-400">Open the bot and press Start</span>
          <a href={link.url} target="_blank" rel="noopener noreferrer" className={BUTTON}>
            Open Telegram
          </a>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => setLink(await connect()))}
          className={BUTTON}
        >
          Connect Telegram
        </button>
      )}
      {error && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

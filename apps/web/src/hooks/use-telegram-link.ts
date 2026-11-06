'use client'

import type { TelegramStatus } from '@onetodone/compress-shared'
import { doc, onSnapshot } from 'firebase/firestore'
import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { getFirebase } from '@/lib/firebase'

/** The Telegram link of the signed-in user and the actions that change it. */
export interface TelegramLinkState {
  /** `null` until known, and while the service has no Telegram bot. */
  status: TelegramStatus | null
  /**
   * Creates a one-time link that opens the bot and connects the Telegram account to this user.
   * @throws ApiError with a message for the user
   */
  connect: () => Promise<{ url: string; expiresAt: Date }>
  /**
   * Disconnects the Telegram account.
   * @throws ApiError with a message for the user
   */
  disconnect: () => Promise<void>
}

/**
 * Returns the Telegram link of a registered user. `GET /me` says whether the service has a bot, and
 * records whether the token shows Google, which the bot checks before it unlinks; the link itself
 * is read live from `users/{uid}`, so a link made in the bot shows up at once.
 *
 * @param uid signed-in user
 * @param hasGoogle whether the user can sign in with Google; a change is reported to the API
 */
export function useTelegramLink(uid: string, hasGoogle: boolean): TelegramLinkState {
  const [available, setAvailable] = useState(false)
  const [live, setLive] = useState<TelegramStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    api.me().then(
      (me) => {
        if (!cancelled) setAvailable(me.telegram !== null)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [uid, hasGoogle])

  useEffect(() => {
    return onSnapshot(doc(getFirebase().firestore, 'users', uid), (snapshot) => {
      const data = snapshot.data()
      const username: unknown = data?.telegramUsername
      setLive({
        linked: typeof data?.telegramId === 'number',
        username: typeof username === 'string' ? username : null,
      })
    })
  }, [uid])

  const connect = useCallback(async () => {
    const { url, expiresAt } = await api.createTelegramLinkCode()
    return { url, expiresAt: new Date(expiresAt) }
  }, [])

  const disconnect = useCallback(() => api.unlinkTelegram(), [])

  return { status: available ? live : null, connect, disconnect }
}

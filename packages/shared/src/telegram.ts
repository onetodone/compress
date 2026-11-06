import { z } from 'zod'

/** Validates a one-time code that links a Telegram account or signs in with it: 22 base64url characters. */
export const linkCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

/** Validates the response of `POST /auth/telegram/link-code`. */
export const createLinkCodeResponseSchema = z.object({
  /** Telegram link that opens the bot with the code. */
  url: z.url(),
  /** ISO timestamp after which the code is refused. */
  expiresAt: z.iso.datetime(),
})

/** Response of `POST /auth/telegram/link-code`: a link that connects a Telegram account to the user. */
export type CreateLinkCodeResponse = z.infer<typeof createLinkCodeResponseSchema>

/** Validates the body of `POST /auth/telegram`. */
export const telegramLoginRequestSchema = z.object({ code: linkCodeSchema })

/** Body of `POST /auth/telegram`: a login code the bot gave. */
export type TelegramLoginRequest = z.infer<typeof telegramLoginRequestSchema>

/** Validates the response of `POST /auth/telegram`. */
export const telegramLoginResponseSchema = z.object({
  /** Firebase custom token for `signInWithCustomToken`. */
  customToken: z.string().min(1),
})

/** Response of `POST /auth/telegram`: a Firebase custom token of the Telegram account's user. */
export type TelegramLoginResponse = z.infer<typeof telegramLoginResponseSchema>

/** Validates the Telegram link of a user. */
export const telegramStatusSchema = z.object({
  /** Whether a Telegram account is linked to the user. */
  linked: z.boolean(),
  /** Username of the linked Telegram account, if it has one. */
  username: z.string().nullable(),
})

/** The Telegram link of a user. */
export type TelegramStatus = z.infer<typeof telegramStatusSchema>

/** Name of the URL fragment parameter that carries a login code to the web app. */
export const TELEGRAM_LOGIN_FRAGMENT = 'telegram-login'

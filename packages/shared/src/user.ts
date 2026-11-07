import { z } from 'zod'

import { telegramStatusSchema } from './telegram.js'

/** Validates the daily quota of a user. */
export const quotaSchema = z.object({
  /** UTC day the counters refer to, e.g. `2026-10-21`. */
  dayKey: z.string(),
  /** Jobs submitted on that day. */
  used: z.number().int().nonnegative(),
  /** Jobs allowed per day. */
  limit: z.number().int().positive(),
})

/** Daily quota of a user. */
export type Quota = z.infer<typeof quotaSchema>

/** Validates the kind of account a user has. */
export const accountKindSchema = z.enum(['anonymous', 'registered'])

/**
 * Kind of account: `anonymous` for a browser session without sign-in, `registered` for any sign-in
 * that identifies the person (Google, or a custom token from another channel).
 */
export type AccountKind = z.infer<typeof accountKindSchema>

/** Validates the per-file limits of a user. */
export const userLimitsSchema = z.object({
  /** Largest original image the user may upload, in bytes. */
  maxInputBytes: z.number().int().positive(),
})

/** Per-file limits of a user. */
export type UserLimits = z.infer<typeof userLimitsSchema>

/** Validates the response of `GET /me`. */
export const meResponseSchema = z.object({
  uid: z.string(),
  kind: accountKindSchema,
  /** Same as `kind === 'anonymous'`; kept for clients that read it. */
  isAnonymous: z.boolean(),
  quota: quotaSchema,
  limits: userLimitsSchema,
  /** Whether the client's network has used up its daily anonymous jobs; always `false` for signed-in users. */
  networkLimitReached: z.boolean(),
  /** The user's Telegram link; `null` when the service has no Telegram bot. Absent from older APIs. */
  telegram: telegramStatusSchema.nullable().default(null),
})

/** Response of `GET /me`: the signed-in user and their quota for today. */
export type MeResponse = z.infer<typeof meResponseSchema>

/** Validates the body of `POST /me/merge`. */
export const mergeSessionRequestSchema = z.object({
  /** Firebase ID token of the anonymous session the user leaves. */
  anonymousToken: z.string().min(1).max(8192),
})

/** Body of `POST /me/merge`: the anonymous session whose images and used quota move to the user. */
export type MergeSessionRequest = z.infer<typeof mergeSessionRequestSchema>

/** Validates the response of `POST /me/merge`. */
export const mergeSessionResponseSchema = z.object({
  /** Jobs that moved to the user. */
  movedJobs: z.number().int().nonnegative(),
})

/** Response of `POST /me/merge`. */
export type MergeSessionResponse = z.infer<typeof mergeSessionResponseSchema>

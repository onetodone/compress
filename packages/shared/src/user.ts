import { z } from 'zod'

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

/** Validates the response of `GET /me`. */
export const meResponseSchema = z.object({
  uid: z.string(),
  isAnonymous: z.boolean(),
  quota: quotaSchema,
  /** Whether the client's network has used up its daily anonymous jobs; always `false` for signed-in users. */
  networkLimitReached: z.boolean(),
})

/** Response of `GET /me`: the signed-in user and their quota for today. */
export type MeResponse = z.infer<typeof meResponseSchema>

import { z } from 'zod'

const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  GCP_PROJECT_ID: z.string().min(1),
  SLOW_CALL_THRESHOLD_MS: z.coerce.number().int().positive().default(1000),
})

const required = z.string().min(1)

const r2ConfigSchema = z.object({
  R2_ACCOUNT_ID: required,
  R2_ACCESS_KEY_ID: required,
  R2_SECRET_ACCESS_KEY: required,
  R2_BUCKET: required,
})

/** An optional variable; an empty value counts as unset. */
function optional<S extends z.ZodType>(schema: S) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional())
}

const cloudinaryConfigSchema = z.object({
  // Without it, previews are not created and the browser shows results straight from R2.
  CLOUDINARY_URL: optional(
    z
      .string()
      .regex(
        /^cloudinary:\/\/[^:@/]+:[^@/]+@[^@/]+$/,
        'Must look like cloudinary://<api_key>:<api_secret>@<cloud_name>',
      ),
  ),
  CLOUDINARY_FOLDER: required.default('image-compressor'),
})

const queueConfigSchema = z.object({
  // The database number in the path keeps apps that share one Redis apart.
  REDIS_URL: z.string().regex(/^rediss?:\/\/[^\s]+$/, 'Must look like redis://[user:password@]host:port[/db]'),
  QUEUE_PREFIX: required.default('image-compressor'),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  // First retry delay; each further retry waits twice as long.
  QUEUE_BACKOFF_MS: z.coerce.number().int().min(0).default(10_000),
})

const quotaConfigSchema = z.object({
  QUOTA_ANONYMOUS_DAILY: z.coerce.number().int().min(1).default(5),
  QUOTA_SIGNED_IN_DAILY: z.coerce.number().int().min(1).default(30),
  // Bounds the free jobs a client gets by starting fresh anonymous sessions; 0 disables the limit.
  QUOTA_ANONYMOUS_PER_IP_DAILY: z.coerce.number().int().min(0).default(20),
})

/** Environment variables of the public API. */
export const apiConfigSchema = baseConfigSchema.extend({
  ...r2ConfigSchema.shape,
  ...cloudinaryConfigSchema.shape,
  ...queueConfigSchema.shape,
  ...quotaConfigSchema.shape,
  CORS_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
})

/** Environment variables of the worker. */
export const workerConfigSchema = baseConfigSchema.extend({
  ...r2ConfigSchema.shape,
  ...cloudinaryConfigSchema.shape,
  ...queueConfigSchema.shape,
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).default(2),
})

/** Environment variables of the Telegram bot. */
export const botConfigSchema = baseConfigSchema.extend({
  ...r2ConfigSchema.shape,
  ...cloudinaryConfigSchema.shape,
  ...queueConfigSchema.shape,
  ...quotaConfigSchema.shape,
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, 'Must look like <bot id>:<secret> as given by @BotFather'),
})

/** Settings shared by the API and the worker. */
export type BaseConfig = z.infer<typeof baseConfigSchema>
/** Cloudflare R2 credentials and bucket. */
export type R2Config = z.infer<typeof r2ConfigSchema>
/** Cloudinary credentials, if previews are enabled, and the folder previews are stored in. */
export type CloudinaryConfig = z.infer<typeof cloudinaryConfigSchema>
/** Redis connection and job queue settings. */
export type QueueConfig = z.infer<typeof queueConfigSchema>
/** Daily job limits per user and per network. */
export type QuotaConfig = z.infer<typeof quotaConfigSchema>
/** Validated configuration of the API service. */
export type ApiConfig = z.infer<typeof apiConfigSchema>
/** Validated configuration of the worker service. */
export type WorkerConfig = z.infer<typeof workerConfigSchema>
/** Validated configuration of the Telegram bot. */
export type BotConfig = z.infer<typeof botConfigSchema>

/**
 * Validates environment variables against a schema.
 *
 * @throws Error listing every missing or invalid variable, so the service refuses to start.
 */
export function parseConfig<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>): z.output<S> {
  const result = schema.safeParse(env)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`)
  }
  return result.data
}

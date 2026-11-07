import type {
  ApiConfig,
  BaseConfig,
  BotConfig,
  CloudinaryConfig,
  QueueConfig,
  R2Config,
  WorkerConfig,
} from '../../src/common/config/config.js'
import { GHOSTSCRIPT_PATH, ghostscriptAvailable } from './ghostscript.js'
import { HEIF_TOOLS_DIR } from './heif.js'

export const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-onetodone-compress-test'

const baseConfig: BaseConfig = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  GCP_PROJECT_ID: PROJECT_ID,
  SLOW_CALL_THRESHOLD_MS: 1000,
}

const r2Config: R2Config = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_BUCKET: 'test-bucket',
}

const cloudinaryConfig: CloudinaryConfig = {
  CLOUDINARY_URL: 'cloudinary://123:test-secret@test-cloud',
  CLOUDINARY_FOLDER: 'onetodone-compress-test',
}

/** Redis database used by tests only; flushed by the tests, so never the development database. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15'

export const queueConfig: QueueConfig = {
  REDIS_URL: TEST_REDIS_URL,
  QUEUE_PREFIX: 'onetodone-compress-test',
  QUEUE_MAX_ATTEMPTS: 3,
  QUEUE_BACKOFF_MS: 10,
}

export const workerConfig: WorkerConfig = {
  ...baseConfig,
  ...r2Config,
  ...cloudinaryConfig,
  ...queueConfig,
  // Without Ghostscript the worker refuses PDF files; the tests that need it are skipped then.
  GHOSTSCRIPT_PATH: ghostscriptAvailable ? GHOSTSCRIPT_PATH : undefined,
  // Likewise HEIC files without the libheif tools.
  HEIF_TOOLS_DIR,
  QUEUE_CONCURRENCY: 2,
}

export const apiConfig: ApiConfig = {
  ...baseConfig,
  ...r2Config,
  ...cloudinaryConfig,
  ...queueConfig,
  CORS_ORIGINS: ['http://localhost:3000'],
  QUOTA_ANONYMOUS_DAILY: 5,
  QUOTA_SIGNED_IN_DAILY: 30,
  QUOTA_ANONYMOUS_PER_IP_DAILY: 20,
  // The API and the bot only check that these are set.
  GHOSTSCRIPT_PATH: 'gs',
  HEIF_TOOLS_DIR: '/usr/bin',
  TELEGRAM_BOT_USERNAME: 'test_compressor_bot',
}

export const botConfig: BotConfig = {
  ...baseConfig,
  ...r2Config,
  ...cloudinaryConfig,
  ...queueConfig,
  QUOTA_ANONYMOUS_DAILY: 5,
  QUOTA_SIGNED_IN_DAILY: 30,
  QUOTA_ANONYMOUS_PER_IP_DAILY: 20,
  GHOSTSCRIPT_PATH: 'gs',
  HEIF_TOOLS_DIR: '/usr/bin',
  TELEGRAM_BOT_TOKEN: '123456:test-token',
  WEB_APP_URL: 'https://img.example.com',
}

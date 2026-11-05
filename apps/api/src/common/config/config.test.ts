import { describe, expect, it } from 'vitest'

import { apiConfigSchema, parseConfig, workerConfigSchema } from './config.js'

const apiEnv = {
  GCP_PROJECT_ID: 'demo-image-compressor',
  CORS_ORIGINS: 'http://localhost:3000, https://example.web.app',
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
  CLOUDINARY_URL: 'cloudinary://123:secret@cloud',
  CLOUDINARY_FOLDER: 'image-compressor-test',
  REDIS_URL: 'redis://127.0.0.1:6379/4',
}

const workerEnv = {
  GCP_PROJECT_ID: 'demo',
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
  CLOUDINARY_URL: 'cloudinary://123:secret@cloud',
  CLOUDINARY_FOLDER: 'image-compressor-test',
  REDIS_URL: 'redis://127.0.0.1:6379/4',
}

describe('parseConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = parseConfig(workerConfigSchema, workerEnv)

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 8080,
      SLOW_CALL_THRESHOLD_MS: 1000,
      QUEUE_PREFIX: 'image-compressor',
      QUEUE_MAX_ATTEMPTS: 5,
      QUEUE_BACKOFF_MS: 10_000,
      QUEUE_CONCURRENCY: 2,
    })
  })

  it('coerces numeric variables', () => {
    const config = parseConfig(workerConfigSchema, {
      ...workerEnv,
      PORT: '3002',
      SLOW_CALL_THRESHOLD_MS: '250',
      QUEUE_MAX_ATTEMPTS: '3',
      QUEUE_CONCURRENCY: '4',
    })

    expect(config.PORT).toBe(3002)
    expect(config.SLOW_CALL_THRESHOLD_MS).toBe(250)
    expect(config.QUEUE_MAX_ATTEMPTS).toBe(3)
    expect(config.QUEUE_CONCURRENCY).toBe(4)
  })

  it('requires the R2 credentials and Redis for the worker', () => {
    expect(() => parseConfig(workerConfigSchema, { GCP_PROJECT_ID: 'demo' })).toThrow(
      /R2_ACCOUNT_ID[\s\S]*R2_BUCKET[\s\S]*REDIS_URL/,
    )
  })

  it('rejects an attempt limit or concurrency below one', () => {
    expect(() => parseConfig(workerConfigSchema, { ...workerEnv, QUEUE_MAX_ATTEMPTS: '0' })).toThrow(
      /QUEUE_MAX_ATTEMPTS/,
    )
    expect(() => parseConfig(workerConfigSchema, { ...workerEnv, QUEUE_CONCURRENCY: '0' })).toThrow(/QUEUE_CONCURRENCY/)
  })

  it('splits CORS origins into a trimmed list', () => {
    expect(parseConfig(apiConfigSchema, apiEnv).CORS_ORIGINS).toEqual([
      'http://localhost:3000',
      'https://example.web.app',
    ])
  })

  it('lists every missing or invalid variable in one error', () => {
    expect(() => parseConfig(apiConfigSchema, { PORT: 'abc', CORS_ORIGINS: 'not a url' })).toThrow(
      /PORT[\s\S]*GCP_PROJECT_ID[\s\S]*CORS_ORIGINS/,
    )
  })

  it('rejects an empty required variable', () => {
    expect(() => parseConfig(apiConfigSchema, { ...apiEnv, GCP_PROJECT_ID: '' })).toThrow(/GCP_PROJECT_ID/)
  })

  it('requires the R2 credentials for the API', () => {
    expect(() => parseConfig(apiConfigSchema, { ...apiEnv, R2_SECRET_ACCESS_KEY: '' })).toThrow(/R2_SECRET_ACCESS_KEY/)
  })

  it('treats Cloudinary as optional and an empty URL as unset', () => {
    for (const value of [undefined, '']) {
      const config = parseConfig(apiConfigSchema, { ...apiEnv, CLOUDINARY_URL: value, CLOUDINARY_FOLDER: undefined })
      expect(config.CLOUDINARY_URL).toBeUndefined()
      expect(config.CLOUDINARY_FOLDER).toBe('image-compressor')
    }
  })

  it('rejects a Cloudinary URL without credentials and keeps the value out of the error', () => {
    for (const value of ['cloudinary://cloud', 'https://123:hidden-value@cloud', 'cloudinary://123:@cloud']) {
      const parse = () => parseConfig(workerConfigSchema, { ...workerEnv, CLOUDINARY_URL: value })
      expect(parse).toThrow(/CLOUDINARY_URL/)
      expect(parse).not.toThrow(/hidden-value/)
    }
  })

  it('requires a Redis URL and keeps its password out of the error', () => {
    expect(() => parseConfig(apiConfigSchema, { ...apiEnv, REDIS_URL: undefined })).toThrow(/REDIS_URL/)
    const parse = () => parseConfig(apiConfigSchema, { ...apiEnv, REDIS_URL: 'http://user:hidden-value@redis:6379' })
    expect(parse).toThrow(/REDIS_URL/)
    expect(parse).not.toThrow(/hidden-value/)
  })

  it('rejects an empty CORS origin list', () => {
    expect(() => parseConfig(apiConfigSchema, { ...apiEnv, CORS_ORIGINS: ' , ' })).toThrow(/CORS_ORIGINS/)
  })
})

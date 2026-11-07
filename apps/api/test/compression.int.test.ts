import type { NestExpressApplication } from '@nestjs/platform-express'
import { utcDayKey } from '@onetodone/compress-shared'
import { Queue, UnrecoverableError } from 'bullmq'
import { FieldValue, Firestore, Timestamp } from 'firebase-admin/firestore'
import { Redis } from 'ioredis'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { NOTIFICATION_QUEUE, notifyTaskId } from '../src/common/tasks/task-queue.js'
import { CompressionConsumer } from '../src/worker/compression/compression.consumer.js'
import { createTestWorkerApp } from './support/app.js'
import { clearFirestore } from './support/emulators.js'
import type { InMemoryImageCdn, InMemoryObjectStorage } from './support/fakes.js'
import { fixture } from './support/fixtures.js'
import { ghostscriptAvailable } from './support/ghostscript.js'
import { heifToolsAvailable } from './support/heif.js'
import { queueConfig, TEST_REDIS_URL } from './support/config.js'
import { flushTestRedis } from './support/redis.js'

const UID = 'user-1'
const JOB_ID = 'a1B2c3D4e5F6g7H8i9J0'
const INPUT_KEY = `originals/${UID}/${JOB_ID}`
const MAX_ATTEMPTS = 3

describe('compression task', () => {
  let app: NestExpressApplication
  let consumer: CompressionConsumer
  let storage: InMemoryObjectStorage
  let cdn: InMemoryImageCdn
  let firestore: Firestore
  let notifications: Queue
  let notificationsConnection: Redis
  const today = utcDayKey(new Date())

  beforeAll(async () => {
    await flushTestRedis()
    ;({ app, storage, cdn } = await createTestWorkerApp())
    consumer = app.get(CompressionConsumer)
    firestore = app.get(Firestore)
    notificationsConnection = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null })
    notifications = new Queue(NOTIFICATION_QUEUE, {
      connection: notificationsConnection,
      prefix: queueConfig.QUEUE_PREFIX,
    })
  })

  afterAll(async () => {
    await notifications.close()
    notificationsConnection.disconnect()
    await app.close()
  })

  beforeEach(async () => {
    await clearFirestore()
    storage.objects.clear()
    storage.unavailable.clear()
    cdn.reset()
    await notifications.obliterate({ force: true })
  })

  const deliver = (data: object = { jobId: JOB_ID }, attempt = 1) =>
    consumer.handle({ data, attempt, maxAttempts: MAX_ATTEMPTS })
  const job = async () => (await firestore.doc(`jobs/${JOB_ID}`).get()).data()
  const jobsToday = async () => (await firestore.doc(`users/${UID}`).get()).get('jobsToday') as number

  async function queueJob(file: Buffer, fields: Record<string, unknown> = {}): Promise<void> {
    storage.upload(INPUT_KEY, { data: file, contentType: 'image/jpeg' })
    const now = FieldValue.serverTimestamp()
    await firestore.doc(`users/${UID}`).set({ dayKey: today, jobsToday: 2, isAnonymous: true, createdAt: now })
    await firestore.doc(`jobs/${JOB_ID}`).set({
      ownerId: UID,
      status: 'queued',
      originalName: 'photo.jpg',
      inputType: 'image/jpeg',
      inputKey: INPUT_KEY,
      inputBytes: file.length,
      outputKey: null,
      outputBytes: null,
      width: null,
      height: null,
      previewUrl: null,
      error: null,
      attempts: 0,
      quotaDayKey: today,
      quotaRefunded: false,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      ...fields,
    })
  }

  it('compresses a queued JPEG and stores the smaller result', async () => {
    const original = fixture('photo.jpg')
    await queueJob(original)

    expect(await deliver()).toBe('done')

    const outputKey = `results/${UID}/${JOB_ID}.jpg`
    const result = storage.objects.get(outputKey)
    expect(result?.contentType).toBe('image/jpeg')
    expect(result!.size).toBeLessThan(original.length)
    expect(await job()).toMatchObject({
      status: 'done',
      inputType: 'image/jpeg',
      outputType: 'image/jpeg',
      inputBytes: original.length,
      outputKey,
      outputBytes: result!.size,
      width: 160,
      height: 120,
      previewUrl: `https://cdn.test/image/upload/c_limit,f_auto,q_auto,w_800/v1/test/${JOB_ID}`,
      error: null,
      attempts: 1,
      finishedAt: expect.any(Timestamp),
    })
    expect(cdn.assets.get(JOB_ID)).toEqual(result!.data)
    expect(await jobsToday()).toBe(2)
  })

  it.runIf(ghostscriptAvailable)('compresses a queued PDF without a preview', async () => {
    const original = fixture('document.pdf')
    await queueJob(original, { originalName: 'report.pdf', inputType: 'application/pdf' })

    expect(await deliver()).toBe('done')

    const outputKey = `results/${UID}/${JOB_ID}.pdf`
    const result = storage.objects.get(outputKey)
    expect(result?.contentType).toBe('application/pdf')
    expect(result!.size).toBeLessThan(original.length)
    expect(await job()).toMatchObject({
      status: 'done',
      inputType: 'application/pdf',
      outputType: 'application/pdf',
      outputKey,
      outputBytes: result!.size,
      width: null,
      height: null,
      previewUrl: null,
    })
    expect(cdn.assets.has(JOB_ID)).toBe(false)
  })

  it.runIf(heifToolsAvailable)('compresses a queued HEIC image with a preview', async () => {
    const original = fixture('photo.heic')
    await queueJob(original, { originalName: 'IMG_1099.HEIC', inputType: 'image/heic' })

    expect(await deliver()).toBe('done')

    const outputKey = `results/${UID}/${JOB_ID}.heic`
    const result = storage.objects.get(outputKey)
    expect(result?.contentType).toBe('image/heic')
    expect(result!.size).toBeLessThan(original.length)
    expect(await job()).toMatchObject({
      status: 'done',
      inputType: 'image/heic',
      outputType: 'image/heic',
      outputKey,
      width: 160,
      height: 120,
      previewUrl: expect.stringContaining(JOB_ID),
    })
    expect(cdn.assets.get(JOB_ID)).toEqual(result!.data)
  })

  it('stores the type detected from the content, not the declared one', async () => {
    await queueJob(fixture('graphic.png'))

    await deliver()

    expect(await job()).toMatchObject({
      status: 'done',
      inputType: 'image/png',
      outputType: 'image/png',
      outputKey: `results/${UID}/${JOB_ID}.png`,
    })
    expect((await sharp(storage.objects.get(`results/${UID}/${JOB_ID}.png`)!.data).metadata()).format).toBe('png')
  })

  it.each([
    ['photo.webp', 'image/webp', 'webp'],
    ['photo.avif', 'image/avif', 'avif'],
  ] as const)('compresses %s into a smaller result of the same type', async (name, type, extension) => {
    const original = fixture(name)
    await queueJob(original, { originalName: name, inputType: type })

    expect(await deliver()).toBe('done')

    const outputKey = `results/${UID}/${JOB_ID}.${extension}`
    const result = storage.objects.get(outputKey)
    expect(result?.contentType).toBe(type)
    expect(result!.size).toBeLessThan(original.length)
    expect(await job()).toMatchObject({ status: 'done', inputType: type, outputType: type, outputKey })
  })

  it('compresses with the stored preset', async () => {
    const original = fixture('photo.jpg')
    await queueJob(original)
    await deliver()
    const balanced = storage.objects.get(`results/${UID}/${JOB_ID}.jpg`)!.size

    await queueJob(original, { settings: { preset: 'smaller' } })
    await deliver()

    expect(storage.objects.get(`results/${UID}/${JOB_ID}.jpg`)!.size).toBeLessThan(balanced)
  })

  it('compresses jobs stored without settings or with an unknown preset at the default preset', async () => {
    const original = fixture('photo.jpg')
    await queueJob(original, { settings: { preset: 'balanced' } })
    await deliver()
    const balanced = storage.objects.get(`results/${UID}/${JOB_ID}.jpg`)!.size

    for (const settings of [undefined, { preset: 'tiny' }]) {
      await queueJob(original, settings ? { settings } : {})
      expect(await deliver()).toBe('done')
      expect(storage.objects.get(`results/${UID}/${JOB_ID}.jpg`)!.size).toBe(balanced)
    }
  })

  it('takes over a job left in processing by a crashed attempt', async () => {
    await queueJob(fixture('photo.jpg'), { status: 'processing', attempts: 1 })

    expect(await deliver({ jobId: JOB_ID }, 2)).toBe('done')

    expect(await job()).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('does nothing for a job that is already finished', async () => {
    for (const status of ['done', 'failed']) {
      await queueJob(fixture('photo.jpg'), { status })

      expect(await deliver()).toBe('skipped')

      expect(await job()).toMatchObject({ status, attempts: 0 })
      expect(storage.objects.size).toBe(1)
    }
  })

  describe('jobs from a chat', () => {
    const chat = { source: 'telegram', notify: { chatId: 1, messageId: 2 } }
    const notification = () => notifications.getJob(notifyTaskId(JOB_ID))

    it('asks the bot to answer once the job is done', async () => {
      await queueJob(fixture('photo.jpg'), chat)

      expect(await deliver()).toBe('done')

      expect((await notification())?.data).toEqual({ jobId: JOB_ID })
    })

    it('asks the bot to answer when the job fails', async () => {
      await queueJob(fixture('corrupt.jpg'), chat)

      expect(await deliver()).toBe('failed')

      expect(await notification()).toBeDefined()
    })

    it('asks again when a finished job was not answered, e.g. after a crash', async () => {
      await queueJob(fixture('photo.jpg'), { ...chat, status: 'done' })

      expect(await deliver()).toBe('skipped')

      expect(await notification()).toBeDefined()
    })

    it('does not ask for jobs already answered or created on the web', async () => {
      await queueJob(fixture('photo.jpg'), { ...chat, status: 'done', notifiedAt: FieldValue.serverTimestamp() })
      expect(await deliver()).toBe('skipped')

      await queueJob(fixture('photo.jpg'), { source: 'web', notify: null })
      expect(await deliver()).toBe('done')

      expect(await notifications.count()).toBe(0)
    })
  })

  it('ignores jobs that do not exist or were never submitted', async () => {
    expect(await deliver()).toBe('skipped')

    await queueJob(fixture('photo.jpg'), { status: 'awaiting_upload' })
    expect(await deliver()).toBe('skipped')
    expect(await job()).toMatchObject({ status: 'awaiting_upload' })
  })

  it('finishes a job once when the same task is delivered concurrently', async () => {
    await queueJob(fixture('photo.jpg'))

    const outcomes = await Promise.all([deliver(), deliver(), deliver()])

    expect(outcomes.every((outcome) => outcome === 'done' || outcome === 'skipped')).toBe(true)
    expect(outcomes).toContain('done')
    expect(await job()).toMatchObject({ status: 'done' })
    expect(await jobsToday()).toBe(2)
  })

  it('fails a corrupt image permanently and refunds the quota exactly once', async () => {
    await queueJob(fixture('corrupt.jpg'))

    expect(await deliver()).toBe('failed')
    expect(await deliver()).toBe('skipped')

    expect(await job()).toMatchObject({
      status: 'failed',
      error: 'The file is not a valid JPEG, PNG, WebP, AVIF or HEIC image',
      quotaRefunded: true,
      outputKey: null,
      finishedAt: expect.any(Timestamp),
    })
    expect(await jobsToday()).toBe(1)
  })

  it('fails a job whose original is missing', async () => {
    await queueJob(fixture('photo.jpg'))
    storage.objects.clear()

    expect(await deliver()).toBe('failed')

    expect(await job()).toMatchObject({ status: 'failed', error: 'The uploaded file is no longer available' })
  })

  it('does not refund a job whose quota was counted on an earlier day', async () => {
    await queueJob(fixture('corrupt.jpg'), { quotaDayKey: '2000-01-01' })

    await deliver()

    expect(await job()).toMatchObject({ status: 'failed', quotaRefunded: false })
    expect(await jobsToday()).toBe(2)
  })

  it('refunds by the creation day for jobs stored without a quota day', async () => {
    await queueJob(fixture('corrupt.jpg'))
    await firestore.doc(`jobs/${JOB_ID}`).update({ quotaDayKey: FieldValue.delete() })

    await deliver()

    expect(await job()).toMatchObject({ status: 'failed', quotaRefunded: true })
    expect(await jobsToday()).toBe(1)
  })

  it('asks for a retry on a transient storage error and keeps the job processing', async () => {
    await queueJob(fixture('photo.jpg'))
    storage.unavailable.add('put')

    await expect(deliver()).rejects.toThrow('R2 is unavailable')

    expect(await job()).toMatchObject({ status: 'processing', attempts: 1, quotaRefunded: false })
    expect(await jobsToday()).toBe(2)

    storage.unavailable.clear()
    expect(await deliver({ jobId: JOB_ID }, 2)).toBe('done')
  })

  it('finishes without a preview when no CDN is configured', async () => {
    await queueJob(fixture('photo.jpg'))
    cdn.disabled = true

    expect(await deliver()).toBe('done')

    expect(await job()).toMatchObject({ status: 'done', previewUrl: null, outputKey: `results/${UID}/${JOB_ID}.jpg` })
    expect(cdn.assets.size).toBe(0)
  })

  it('asks for a retry when the CDN is unavailable and finishes on the next delivery', async () => {
    await queueJob(fixture('photo.jpg'))
    cdn.unavailable.add('upload')

    await expect(deliver()).rejects.toThrow('Cloudinary is unavailable')

    expect(await job()).toMatchObject({ status: 'processing', previewUrl: null })

    cdn.unavailable.clear()
    expect(await deliver({ jobId: JOB_ID }, 2)).toBe('done')
    expect(await job()).toMatchObject({ status: 'done', previewUrl: expect.stringContaining(JOB_ID) })
    expect(cdn.assets.size).toBe(1)
  })

  it('removes its own result when the job is deleted while it is being compressed', async () => {
    await queueJob(fixture('photo.jpg'))
    cdn.beforeUpload = async () => {
      await firestore.doc(`jobs/${JOB_ID}`).delete()
    }

    expect(await deliver()).toBe('skipped')

    expect(await job()).toBeUndefined()
    expect(storage.objects.has(`results/${UID}/${JOB_ID}.jpg`)).toBe(false)
    expect(cdn.assets.size).toBe(0)
  })

  it('fails the job and refunds the quota when the last attempt hits a transient error', async () => {
    await queueJob(fixture('photo.jpg'), { status: 'processing', attempts: MAX_ATTEMPTS - 1 })
    storage.unavailable.add('get')

    expect(await deliver({ jobId: JOB_ID }, MAX_ATTEMPTS)).toBe('failed')

    expect(await job()).toMatchObject({
      status: 'failed',
      error: 'The file could not be processed. Please try again later.',
      attempts: MAX_ATTEMPTS,
      quotaRefunded: true,
    })
    expect(await jobsToday()).toBe(1)
  })

  it('fails the job without compressing it when an earlier last attempt never finished', async () => {
    await queueJob(fixture('photo.jpg'), { status: 'processing', attempts: MAX_ATTEMPTS })

    expect(await deliver({ jobId: JOB_ID }, MAX_ATTEMPTS + 1)).toBe('failed')

    expect(await job()).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, quotaRefunded: true })
    expect(storage.objects.has(`results/${UID}/${JOB_ID}.jpg`)).toBe(false)
    expect(await jobsToday()).toBe(1)
  })

  it('rejects a task without a valid job id so it is never retried', async () => {
    await expect(deliver({})).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(deliver({ jobId: '../users/user-1' })).rejects.toBeInstanceOf(UnrecoverableError)
  })
})

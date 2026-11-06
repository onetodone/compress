import type { NestExpressApplication } from '@nestjs/platform-express'
import { utcDayKey } from '@onetodone/image-compressor-shared'
import { Queue } from 'bullmq'
import { Firestore, Timestamp } from 'firebase-admin/firestore'
import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  COMPRESS_TASK,
  COMPRESSION_QUEUE,
  compressTaskId,
  NOTIFICATION_QUEUE,
  notifyTaskId,
} from '../src/common/tasks/task-queue.js'
import { CLEANUP_SCHEDULER_ID, CleanupConsumer, MAINTENANCE_QUEUE } from '../src/worker/cleanup/cleanup.consumer.js'
import { CleanupService } from '../src/worker/cleanup/cleanup.service.js'
import { CLEANUP_PATTERN } from '../src/worker/cleanup/stale-jobs.js'
import { createTestWorkerApp } from './support/app.js'
import { queueConfig, TEST_REDIS_URL } from './support/config.js'
import { clearFirestore } from './support/emulators.js'
import type { InMemoryImageCdn, InMemoryObjectStorage } from './support/fakes.js'
import { flushTestRedis, waitFor } from './support/redis.js'

const UID = 'user-1'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('stale job cleanup', () => {
  let app: NestExpressApplication
  let cleanup: CleanupService
  let storage: InMemoryObjectStorage
  let cdn: InMemoryImageCdn
  let firestore: Firestore
  let inspector: Queue
  let inspectorConnection: Redis
  const today = utcDayKey(new Date())
  const yesterday = utcDayKey(new Date(Date.now() - DAY))

  beforeAll(() => {
    inspectorConnection = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null })
    inspector = new Queue(COMPRESSION_QUEUE, { connection: inspectorConnection, prefix: queueConfig.QUEUE_PREFIX })
  })

  afterAll(async () => {
    await inspector.close()
    inspectorConnection.disconnect()
  })

  beforeEach(async () => {
    await flushTestRedis()
    await clearFirestore()
    ;({ app, storage, cdn } = await createTestWorkerApp())
    cleanup = app.get(CleanupService)
    firestore = app.get(Firestore)
    await firestore.doc(`users/${UID}`).set({ dayKey: today, jobsToday: 3, isAnonymous: true })
  })

  afterEach(() => app.close())

  const ago = (ms: number) => Timestamp.fromMillis(Date.now() - ms)
  const job = async (id: string) => (await firestore.doc(`jobs/${id}`).get()).data()
  const jobsToday = async () => (await firestore.doc(`users/${UID}`).get()).get('jobsToday') as number

  /** Writes a job document; `age` is the time since it was created, `idle` since its last update. */
  async function seed(
    id: string,
    status: string,
    { age, idle = age, ...fields }: { age: number; idle?: number } & Record<string, unknown>,
  ): Promise<void> {
    const done = status === 'done'
    await firestore.doc(`jobs/${id}`).set({
      ownerId: UID,
      status,
      originalName: 'photo.jpg',
      inputType: 'image/jpeg',
      outputType: done ? 'image/jpeg' : null,
      settings: { preset: 'balanced' },
      inputKey: `originals/${UID}/${id}`,
      inputBytes: status === 'awaiting_upload' ? null : 100,
      outputKey: done ? `results/${UID}/${id}.jpg` : null,
      outputBytes: done ? 60 : null,
      width: null,
      height: null,
      previewUrl: null,
      error: null,
      attempts: 0,
      quotaDayKey: status === 'awaiting_upload' ? null : today,
      quotaRefunded: false,
      createdAt: ago(age),
      updatedAt: ago(idle),
      finishedAt: done ? ago(idle) : null,
      ...fields,
    })
    storage.upload(`originals/${UID}/${id}`, { size: 100, contentType: 'image/jpeg' })
    if (done) storage.upload(`results/${UID}/${id}.jpg`, { size: 60, contentType: 'image/jpeg' })
  }

  describe('uploads that never finished', () => {
    it('deletes a job awaiting its upload for more than a day, with its original', async () => {
      await seed('abandoned0000000000a', 'awaiting_upload', { age: DAY + HOUR })

      expect(await cleanup.run()).toMatchObject({ abandonedUploads: 1, errors: 0 })

      expect(await job('abandoned0000000000a')).toBeUndefined()
      expect(storage.objects.has(`originals/${UID}/abandoned0000000000a`)).toBe(false)
    })

    it('keeps a job awaiting its upload for less than a day', async () => {
      await seed('recentUpload0000000a', 'awaiting_upload', { age: 2 * HOUR })

      expect(await cleanup.run()).toMatchObject({ abandonedUploads: 0 })

      expect(await job('recentUpload0000000a')).toMatchObject({ status: 'awaiting_upload' })
    })
  })

  describe('jobs without a compression task', () => {
    it('fails a queued job whose task is gone and gives its quota back', async () => {
      await seed('lostTask000000000000', 'queued', { age: 2 * HOUR })

      expect(await cleanup.run()).toMatchObject({ stuckJobs: 1, errors: 0 })

      expect(await job('lostTask000000000000')).toMatchObject({
        status: 'failed',
        error: 'The image could not be processed. Please try again later.',
        quotaRefunded: true,
      })
      expect(await jobsToday()).toBe(2)
    })

    it('asks the bot to answer a failed job that came from a chat', async () => {
      await seed('lostChatTask00000000', 'queued', {
        age: 2 * HOUR,
        source: 'telegram',
        notify: { chatId: 1, messageId: 2 },
      })

      expect(await cleanup.run()).toMatchObject({ stuckJobs: 1, errors: 0 })

      const notifications = new Queue(NOTIFICATION_QUEUE, {
        connection: inspectorConnection,
        prefix: queueConfig.QUEUE_PREFIX,
      })
      expect((await notifications.getJob(notifyTaskId('lostChatTask00000000')))?.data).toEqual({
        jobId: 'lostChatTask00000000',
      })
      await notifications.close()
    })

    it('fails a processing job whose task BullMQ has failed', async () => {
      await seed('failedTask0000000000', 'processing', { age: 2 * HOUR })
      // The worker refuses task data without a valid job id and fails the task for good.
      await inspector.add(COMPRESS_TASK, { jobId: 'invalid' }, { jobId: compressTaskId('failedTask0000000000') })
      await waitFor(async () =>
        (await inspector.getJobState(compressTaskId('failedTask0000000000'))) === 'failed' ? true : undefined,
      )

      expect(await cleanup.run()).toMatchObject({ stuckJobs: 1 })

      expect(await job('failedTask0000000000')).toMatchObject({ status: 'failed', quotaRefunded: true })
    })

    it('keeps a queued job whose task is waiting for a retry', async () => {
      await seed('retrying000000000000', 'queued', { age: 2 * HOUR })
      await inspector.add(
        COMPRESS_TASK,
        { jobId: 'retrying000000000000' },
        { jobId: compressTaskId('retrying000000000000'), delay: HOUR },
      )

      expect(await cleanup.run()).toMatchObject({ stuckJobs: 0 })

      expect(await job('retrying000000000000')).toMatchObject({ status: 'queued' })
    })

    it('keeps a queued job updated within the retry window', async () => {
      await seed('justQueued0000000000', 'queued', { age: MINUTE })

      expect(await cleanup.run()).toMatchObject({ stuckJobs: 0 })

      expect(await job('justQueued0000000000')).toMatchObject({ status: 'queued' })
    })

    it('gives no quota back once the counter has moved on to another day', async () => {
      await seed('lastNight00000000000', 'queued', { age: 2 * HOUR, quotaDayKey: yesterday })

      expect(await cleanup.run()).toMatchObject({ stuckJobs: 1 })

      expect(await job('lastNight00000000000')).toMatchObject({ status: 'failed', quotaRefunded: false })
      expect(await jobsToday()).toBe(3)
    })
  })

  describe('jobs past the result lifetime', () => {
    it('deletes a finished job older than its result, with its files and preview', async () => {
      await seed('expired0000000000000', 'done', {
        age: 7 * DAY,
        previewUrl: 'https://cdn.test/image/upload/v1/test/expired0000000000000',
      })
      cdn.assets.set('expired0000000000000', Buffer.alloc(1))

      expect(await cleanup.run()).toMatchObject({ expiredJobs: 1, errors: 0 })

      expect(await job('expired0000000000000')).toBeUndefined()
      expect(storage.objects.size).toBe(0)
      expect(cdn.assets.has('expired0000000000000')).toBe(false)
    })

    it('deletes a failed job of the same age', async () => {
      await seed('expiredFailed0000000', 'failed', { age: 8 * DAY })

      expect(await cleanup.run()).toMatchObject({ expiredJobs: 1 })

      expect(await job('expiredFailed0000000')).toBeUndefined()
    })

    it('keeps a finished job whose result is still stored', async () => {
      await seed('sixDaysOld0000000000', 'done', { age: 6 * DAY })

      expect(await cleanup.run()).toMatchObject({ expiredJobs: 0 })

      expect(await job('sixDaysOld0000000000')).toMatchObject({ status: 'done' })
      expect(storage.objects.size).toBe(2)
    })
  })

  it('changes nothing when it runs again', async () => {
    await seed('abandoned0000000000b', 'awaiting_upload', { age: 2 * DAY })
    await seed('lostTask000000000001', 'queued', { age: 2 * HOUR })
    await seed('expired0000000000001', 'done', { age: 8 * DAY })
    await cleanup.run()

    expect(await cleanup.run()).toEqual({ abandonedUploads: 0, stuckJobs: 0, expiredJobs: 0, errors: 0 })
    expect(await jobsToday()).toBe(2)
  })

  it('keeps one cleanup schedule however many workers start', async () => {
    const other = await createTestWorkerApp()
    try {
      await app.get(CleanupConsumer).whenScheduled()
      await other.app.get(CleanupConsumer).whenScheduled()

      const maintenance = new Queue(MAINTENANCE_QUEUE, {
        connection: inspectorConnection,
        prefix: queueConfig.QUEUE_PREFIX,
      })
      try {
        const schedulers = await maintenance.getJobSchedulers()
        expect(schedulers).toHaveLength(1)
        expect(schedulers[0]).toMatchObject({ key: CLEANUP_SCHEDULER_ID, pattern: CLEANUP_PATTERN })
        expect(await maintenance.getDelayedCount()).toBe(1)
      } finally {
        await maintenance.close()
      }
    } finally {
      await other.app.close()
    }
  })
})

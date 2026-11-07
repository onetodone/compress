import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { utcDayKey } from '@onetodone/compress-shared'
import { Queue } from 'bullmq'
import { FieldValue, Firestore } from 'firebase-admin/firestore'
import { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CallTimer } from '../src/common/logging/call-timer.js'
import { BullTaskQueue } from '../src/common/tasks/bull-task-queue.js'
import { createRedisConnection } from '../src/common/tasks/redis.js'
import { COMPRESSION_QUEUE, compressTaskId } from '../src/common/tasks/task-queue.js'
import { createTestWorkerApp } from './support/app.js'
import { queueConfig, TEST_REDIS_URL } from './support/config.js'
import { clearFirestore } from './support/emulators.js'
import type { InMemoryImageCdn, InMemoryObjectStorage } from './support/fakes.js'
import { fixture } from './support/fixtures.js'
import { flushTestRedis, waitFor } from './support/redis.js'

const UID = 'user-1'
const JOB_ID = 'q1B2c3D4e5F6g7H8i9J0'
const INPUT_KEY = `originals/${UID}/${JOB_ID}`

describe('compression queue', () => {
  let tasks: BullTaskQueue
  let inspector: Queue
  let inspectorConnection: Redis

  beforeAll(() => {
    tasks = new BullTaskQueue(
      createRedisConnection(TEST_REDIS_URL, 'producer'),
      queueConfig,
      new CallTimer(1000, new Logger('test')),
    )
    inspectorConnection = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null })
    inspector = new Queue(COMPRESSION_QUEUE, { connection: inspectorConnection, prefix: queueConfig.QUEUE_PREFIX })
  })

  afterAll(async () => {
    await tasks.close()
    await inspector.close()
    inspectorConnection.disconnect()
  })

  beforeEach(async () => {
    await flushTestRedis()
    await clearFirestore()
  })

  describe('without a worker', () => {
    it('holds one pending task when the same job is enqueued twice', async () => {
      await tasks.enqueueCompression(JOB_ID)
      await tasks.enqueueCompression(JOB_ID)

      expect(await inspector.getWaitingCount()).toBe(1)
      const task = await inspector.getJob(compressTaskId(JOB_ID))
      expect(task?.data).toEqual({ jobId: JOB_ID })
      expect(task?.opts).toMatchObject({ attempts: queueConfig.QUEUE_MAX_ATTEMPTS })
    })
  })

  describe('with a worker', () => {
    let app: NestExpressApplication
    let storage: InMemoryObjectStorage
    let cdn: InMemoryImageCdn
    let firestore: Firestore
    const today = utcDayKey(new Date())

    beforeEach(async () => {
      ;({ app, storage, cdn } = await createTestWorkerApp())
      firestore = app.get(Firestore)
    })

    afterEach(() => app.close())

    const job = async () => (await firestore.doc(`jobs/${JOB_ID}`).get()).data()
    const jobsToday = async () => (await firestore.doc(`users/${UID}`).get()).get('jobsToday') as number
    const settled = () =>
      waitFor(async () => {
        const data = await job()
        return data?.status === 'done' || data?.status === 'failed' ? data : undefined
      })

    async function queueJob(file: Buffer): Promise<void> {
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
      })
    }

    it('compresses an enqueued job and removes the finished task', async () => {
      await queueJob(fixture('photo.jpg'))

      await tasks.enqueueCompression(JOB_ID)

      expect(await settled()).toMatchObject({ status: 'done', attempts: 1 })
      await waitFor(async () => ((await inspector.getJob(compressTaskId(JOB_ID))) ? undefined : true))
    })

    it('retries a transient error and fails the job with a refund after the last attempt', async () => {
      await queueJob(fixture('photo.jpg'))
      storage.unavailable.add('put')

      await tasks.enqueueCompression(JOB_ID)

      expect(await settled()).toMatchObject({
        status: 'failed',
        error: 'The file could not be processed. Please try again later.',
        attempts: queueConfig.QUEUE_MAX_ATTEMPTS,
        quotaRefunded: true,
      })
      expect(await jobsToday()).toBe(1)
    })

    it('finishes after a transient error once the service is back', async () => {
      await queueJob(fixture('photo.jpg'))
      cdn.unavailable.add('upload')
      let uploads = 0
      cdn.beforeUpload = () => {
        if (++uploads === 2) cdn.unavailable.clear()
        return Promise.resolve()
      }

      await tasks.enqueueCompression(JOB_ID)

      expect(await settled()).toMatchObject({ status: 'done', attempts: 2, quotaRefunded: false })
    })

    it('does not retry a permanent error', async () => {
      await queueJob(fixture('corrupt.jpg'))

      await tasks.enqueueCompression(JOB_ID)

      expect(await settled()).toMatchObject({ status: 'failed', attempts: 1, quotaRefunded: true })
      expect(await jobsToday()).toBe(1)
    })

    it('finishes the running task before the worker shuts down', async () => {
      await queueJob(fixture('photo.jpg'))
      let started!: () => void
      const running = new Promise<void>((resolve) => (started = resolve))
      cdn.beforeUpload = async () => {
        started()
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      await tasks.enqueueCompression(JOB_ID)
      await running
      await app.close()

      ;({ app } = await createTestWorkerApp())
      firestore = app.get(Firestore)
      expect(await job()).toMatchObject({ status: 'done', attempts: 1 })
    })
  })
})

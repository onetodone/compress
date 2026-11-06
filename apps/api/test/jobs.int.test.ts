import type { NestExpressApplication } from '@nestjs/platform-express'
import {
  createJobResponseSchema,
  type CreateJobResponse,
  DOWNLOAD_URL_TTL_SECONDS,
  downloadJobResponseSchema,
  listJobsResponseSchema,
  MAX_INPUT_BYTES,
  submitJobResponseSchema,
  UPLOAD_URL_TTL_SECONDS,
  utcDayKey,
} from '@onetodone/image-compressor-shared'
import { FieldValue, Firestore, Timestamp } from 'firebase-admin/firestore'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApiApp } from './support/app.js'
import { clearFirestore, signInAnonymously, signUpWithEmail } from './support/emulators.js'
import type {
  InMemoryImageCdn,
  InMemoryNetworkQuota,
  InMemoryObjectStorage,
  RecordingTaskQueue,
} from './support/fakes.js'

const photo = { originalName: 'photo.jpg', contentType: 'image/jpeg', size: 2048 }

describe('jobs', () => {
  let app: NestExpressApplication
  let storage: InMemoryObjectStorage
  let cdn: InMemoryImageCdn
  let tasks: RecordingTaskQueue
  let networks: InMemoryNetworkQuota
  let firestore: Firestore
  let user: { token: string; uid: string }

  beforeAll(async () => {
    ;({ app, storage, cdn, tasks, networks } = await createTestApiApp())
    firestore = app.get(Firestore)
  })

  afterAll(() => app.close())

  beforeEach(async () => {
    await clearFirestore()
    storage.objects.clear()
    storage.presigned.clear()
    storage.unavailable.clear()
    cdn.reset()
    tasks.enqueued.length = 0
    networks.counters.clear()
    user = await signInAnonymously()
  })

  const http = () => request(app.getHttpServer())
  const auth = (token = user.token) => ({ Authorization: `Bearer ${token}` })

  async function createJob(body: object = photo, token = user.token): Promise<CreateJobResponse> {
    const response = await http().post('/jobs').set(auth(token)).send(body).expect(201)
    return createJobResponseSchema.parse(response.body)
  }

  const submit = (jobId: string, token = user.token) => http().post(`/jobs/${jobId}/submit`).set(auth(token))
  const job = async (jobId: string) => (await firestore.doc(`jobs/${jobId}`).get()).data()
  const jobsToday = async () => (await firestore.doc(`users/${user.uid}`).get()).get('jobsToday') as number | undefined
  const useWholeQuota = () =>
    firestore.doc(`users/${user.uid}`).set({ dayKey: utcDayKey(new Date()), jobsToday: 5, isAnonymous: true })

  /** Creates a finished job with its original, result and preview in place, as the worker leaves it. */
  async function finishedJob(fields: Record<string, unknown> = {}): Promise<{ jobId: string; keys: string[] }> {
    const { jobId } = await createJob()
    const inputKey = `originals/${user.uid}/${jobId}`
    const outputKey = `results/${user.uid}/${jobId}.png`
    storage.upload(inputKey)
    storage.upload(outputKey, { data: Buffer.from('result'), contentType: 'image/png' })
    cdn.assets.set(jobId, Buffer.from('result'))
    await firestore.doc(`jobs/${jobId}`).update({
      status: 'done',
      originalName: 'Схема (v2).jpg',
      inputType: 'image/png',
      outputType: 'image/png',
      outputKey,
      outputBytes: 6,
      previewUrl: `https://cdn.test/${jobId}`,
      ...fields,
    })
    return { jobId, keys: [inputKey, outputKey] }
  }

  describe('POST /jobs', () => {
    it('requires a token', async () => {
      await http().post('/jobs').send(photo).expect(401)
    })

    it('creates a job awaiting upload and returns a presigned upload URL', async () => {
      const before = Date.now()
      const { jobId, uploadUrl, uploadExpiresAt } = await createJob()

      const inputKey = `originals/${user.uid}/${jobId}`
      expect(uploadUrl).toContain(inputKey)
      expect(Date.parse(uploadExpiresAt)).toBeGreaterThanOrEqual(before + UPLOAD_URL_TTL_SECONDS * 1000)
      expect(storage.presigned.get(inputKey)).toEqual({
        contentType: 'image/jpeg',
        contentLength: 2048,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      })
      expect(await job(jobId)).toMatchObject({
        ownerId: user.uid,
        status: 'awaiting_upload',
        originalName: 'photo.jpg',
        inputType: 'image/jpeg',
        outputType: null,
        settings: { preset: 'balanced' },
        inputKey,
        inputBytes: null,
        outputKey: null,
        attempts: 0,
        quotaDayKey: null,
        quotaRefunded: false,
        createdAt: expect.anything(),
        finishedAt: null,
      })
    })

    it('stores the compression preset of the request', async () => {
      const response = await http()
        .post('/jobs')
        .set(auth())
        .send({ ...photo, contentType: 'image/avif', settings: { preset: 'smaller' } })
        .expect(201)
      const { jobId } = createJobResponseSchema.parse(response.body)

      expect(await job(jobId)).toMatchObject({ inputType: 'image/avif', settings: { preset: 'smaller' } })
    })

    it('does not consume quota', async () => {
      await createJob()

      expect(await jobsToday()).toBeUndefined()
    })

    it.each([
      ['an unsupported type', { ...photo, contentType: 'image/gif' }],
      ['an unknown preset', { ...photo, settings: { preset: 'tiny' } }],
      ['a file over 10 MB', { ...photo, size: MAX_INPUT_BYTES + 1 }],
      ['a missing name', { contentType: 'image/png', size: 10 }],
      ['a name with a path', { ...photo, originalName: '../photo.jpg' }],
    ])('rejects %s', async (_case, body) => {
      const response = await http().post('/jobs').set(auth()).send(body).expect(400)

      expect(response.body.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]),
      )
      expect(storage.presigned.size).toBe(0)
    })

    it('refuses to create a job when the daily quota is used up', async () => {
      await useWholeQuota()

      const response = await http().post('/jobs').set(auth()).send(photo).expect(429)

      expect(response.body).toMatchObject({ code: 'daily_limit' })
    })
  })

  describe('POST /jobs/:id/submit', () => {
    it('consumes quota, queues the job and enqueues it', async () => {
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)

      const response = await submit(jobId).expect(200)

      expect(submitJobResponseSchema.parse(response.body)).toEqual({ jobId, status: 'queued' })
      expect(await job(jobId)).toMatchObject({ status: 'queued', inputBytes: 2048, quotaDayKey: utcDayKey(new Date()) })
      expect(await jobsToday()).toBe(1)
      expect(tasks.enqueued).toEqual([jobId])
    })

    it('rejects a submit before the file is uploaded', async () => {
      const { jobId } = await createJob()

      await submit(jobId).expect(409)

      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload' })
      expect(await jobsToday()).toBeUndefined()
      expect(tasks.enqueued).toEqual([])
    })

    it('rejects an object whose type or size does not match the job', async () => {
      const { jobId } = await createJob()
      const key = `originals/${user.uid}/${jobId}`

      storage.upload(key, { contentType: 'image/png' })
      await submit(jobId).expect(400)
      storage.upload(key, { size: MAX_INPUT_BYTES + 1 })
      await submit(jobId).expect(400)

      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload' })
      expect(await jobsToday()).toBeUndefined()
    })

    it('leaves the job awaiting upload when the daily quota is used up', async () => {
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)
      await useWholeQuota()

      await submit(jobId).expect(429)

      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload' })
      expect(tasks.enqueued).toEqual([])
    })

    it('consumes quota once when the same job is submitted again', async () => {
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)

      await submit(jobId).expect(200)
      const response = await submit(jobId).expect(200)

      expect(response.body).toEqual({ jobId, status: 'queued' })
      expect(await jobsToday()).toBe(1)
      expect(tasks.enqueued).toEqual([jobId, jobId])
    })

    it('consumes quota once under concurrent submits of the same job', async () => {
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)

      const responses = await Promise.all(Array.from({ length: 4 }, () => submit(jobId)))

      expect(responses.some((response) => response.status === 200)).toBe(true)
      expect(await jobsToday()).toBe(1)
      expect(await job(jobId)).toMatchObject({ status: 'queued' })
    })

    it('does not enqueue a job that already finished', async () => {
      const { jobId } = await createJob()
      await firestore.doc(`jobs/${jobId}`).update({ status: 'done' })

      const response = await submit(jobId).expect(200)

      expect(response.body).toEqual({ jobId, status: 'done' })
      expect(tasks.enqueued).toEqual([])
    })

    it("hides another user's job", async () => {
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)
      const other = await signInAnonymously()

      await submit(jobId, other.token).expect(404)

      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload' })
    })

    it('answers 404 for unknown and malformed job ids', async () => {
      await submit('a1B2c3D4e5F6g7H8i9J0').expect(404)
      await submit('not-a-job-id').expect(404)
    })
  })

  describe('per-network limit on anonymous jobs', () => {
    // The test client connects over loopback, a trusted proxy, so X-Forwarded-For sets the client address.
    const clientIp = '203.0.113.7'
    const networkKey = () => `${utcDayKey(new Date())}:${clientIp}`
    const useWholeNetworkLimit = () => networks.counters.set(networkKey(), 20)

    async function uploadedJob(token = user.token, uid = user.uid): Promise<string> {
      const response = await http().post('/jobs').set(auth(token)).set('X-Forwarded-For', clientIp).send(photo)
      expect(response.status).toBe(201)
      const { jobId } = createJobResponseSchema.parse(response.body)
      storage.upload(`originals/${uid}/${jobId}`)
      return jobId
    }

    const submitFrom = (jobId: string, token = user.token) =>
      http().post(`/jobs/${jobId}/submit`).set(auth(token)).set('X-Forwarded-For', clientIp)

    it('counts submitted anonymous jobs per client address', async () => {
      await submitFrom(await uploadedJob()).expect(200)
      const other = await signInAnonymously()
      await submitFrom(await uploadedJob(other.token, other.uid), other.token).expect(200)

      expect(networks.counters.get(networkKey())).toBe(2)
    })

    it('refuses a fresh anonymous session from a network that used up its limit', async () => {
      const jobId = await uploadedJob()
      useWholeNetworkLimit()

      const created = await http().post('/jobs').set(auth()).set('X-Forwarded-For', clientIp).send(photo).expect(429)
      const submitted = await submitFrom(jobId).expect(429)

      expect(created.body).toMatchObject({ code: 'network_daily_limit' })
      expect(submitted.body).toMatchObject({ code: 'network_daily_limit' })
      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload' })
      expect(await jobsToday()).toBeUndefined()
      expect(tasks.enqueued).toEqual([])
    })

    it('reports a used-up network in GET /me for anonymous users only', async () => {
      const me = (token = user.token) => http().get('/me').set(auth(token)).set('X-Forwarded-For', clientIp).expect(200)
      const signedIn = await signUpWithEmail()

      expect((await me()).body).toMatchObject({ networkLimitReached: false })
      useWholeNetworkLimit()
      expect((await me()).body).toMatchObject({ networkLimitReached: true })
      expect((await me(signedIn.token)).body).toMatchObject({ networkLimitReached: false })
    })

    it('does not limit other networks', async () => {
      useWholeNetworkLimit()
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)

      await submit(jobId).expect(200)
    })

    it('does not limit signed-in users', async () => {
      const signedIn = await signUpWithEmail()
      useWholeNetworkLimit()
      const jobId = await uploadedJob(signedIn.token, signedIn.uid)

      await submitFrom(jobId, signedIn.token).expect(200)

      expect(networks.counters.get(networkKey())).toBe(20)
    })

    it("gives the network its job back when the user's own quota refuses the submit", async () => {
      const jobId = await uploadedJob()
      await useWholeQuota()

      const response = await submitFrom(jobId).expect(429)

      expect(response.body).toMatchObject({ code: 'daily_limit' })
      expect(networks.counters.get(networkKey())).toBe(0)
    })

    it('counts a job once when it is submitted again or concurrently', async () => {
      const jobId = await uploadedJob()

      await Promise.all(Array.from({ length: 3 }, () => submitFrom(jobId)))
      await submitFrom(jobId).expect(200)

      expect(networks.counters.get(networkKey())).toBe(1)
    })
  })

  describe('GET /jobs', () => {
    const list = (query = '', token = user.token) => http().get(`/jobs${query}`).set(auth(token))

    /** Stores jobs created one second apart, oldest first, and returns their ids newest first. */
    async function seedJobs(count: number, ownerId = user.uid): Promise<string[]> {
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const ref = firestore.collection('jobs').doc()
        await ref.set({
          ownerId,
          status: 'done',
          originalName: `photo-${i}.jpg`,
          inputType: 'image/jpeg',
          inputKey: `originals/${ownerId}/${ref.id}`,
          inputBytes: 2048,
          outputKey: `results/${ownerId}/${ref.id}.jpg`,
          outputBytes: 1024,
          width: 64,
          height: 48,
          previewUrl: null,
          error: null,
          createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 21, 10, 0, i)),
          finishedAt: Timestamp.fromMillis(Date.UTC(2026, 9, 21, 10, 0, i, 500)),
        })
        ids.unshift(ref.id)
      }
      return ids
    }

    it('requires a token', async () => {
      await http().get('/jobs').expect(401)
    })

    it("returns the user's jobs newest first without storage keys", async () => {
      const ids = await seedJobs(3)
      await seedJobs(2, 'someone-else')

      const response = await list().expect(200)

      const page = listJobsResponseSchema.parse(response.body)
      expect(page.jobs.map((job) => job.id)).toEqual(ids)
      expect(page.nextCursor).toBeNull()
      expect(page.jobs[0]).toEqual({
        id: ids[0],
        status: 'done',
        originalName: 'photo-2.jpg',
        inputType: 'image/jpeg',
        outputType: null,
        inputBytes: 2048,
        outputBytes: 1024,
        width: 64,
        height: 48,
        previewUrl: null,
        error: null,
        createdAt: '2026-10-21T10:00:02.000Z',
        finishedAt: '2026-10-21T10:00:02.500Z',
      })
      expect(response.body.jobs[0]).not.toHaveProperty('inputKey')
    })

    it('keeps jobs of unknown types and statuses and leaves out documents it cannot read', async () => {
      const [id] = await seedJobs(1)
      await firestore.doc(`jobs/${id}`).update({ status: 'archived', inputType: 'image/jxl', outputType: 'image/jxl' })
      await firestore.collection('jobs').add({ ownerId: user.uid, status: 'done', createdAt: Timestamp.now() })

      const page = listJobsResponseSchema.parse((await list().expect(200)).body)

      expect(page.jobs).toEqual([
        expect.objectContaining({ id, status: 'unknown', inputType: 'image/jxl', outputType: 'image/jxl' }),
      ])
    })

    it('pages through all jobs with the cursor', async () => {
      const ids = await seedJobs(5)

      const first = listJobsResponseSchema.parse((await list('?limit=2').expect(200)).body)
      const second = listJobsResponseSchema.parse((await list(`?limit=2&cursor=${first.nextCursor}`).expect(200)).body)
      const third = listJobsResponseSchema.parse((await list(`?limit=2&cursor=${second.nextCursor}`).expect(200)).body)

      expect([...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.id)).toEqual(ids)
      expect(third.nextCursor).toBeNull()
    })

    it('includes a job created through the API', async () => {
      const { jobId } = await createJob()

      const page = listJobsResponseSchema.parse((await list().expect(200)).body)

      expect(page.jobs).toEqual([expect.objectContaining({ id: jobId, status: 'awaiting_upload', inputBytes: null })])
    })

    it('returns an empty page for a user without jobs', async () => {
      expect((await list().expect(200)).body).toEqual({ jobs: [], nextCursor: null })
    })

    it('rejects an invalid cursor or page size', async () => {
      await list('?cursor=garbage').expect(400)
      await list('?limit=0').expect(400)
      await list('?limit=51').expect(400)
    })
  })

  describe('GET /jobs/:id/download', () => {
    const download = (jobId: string, token = user.token) => http().get(`/jobs/${jobId}/download`).set(auth(token))

    it('returns a short-lived URL that saves the result under the original name with the detected type', async () => {
      const { jobId } = await finishedJob()
      const before = Date.now()

      const { url, expiresAt } = downloadJobResponseSchema.parse((await download(jobId).expect(200)).body)

      const params = new URL(url).searchParams
      expect(new URL(url).pathname).toBe(`/results/${user.uid}/${jobId}.png`)
      expect(params.get('response-content-type')).toBe('image/png')
      expect(params.get('response-content-disposition')).toBe(
        `attachment; filename="_____ (v2).png"; filename*=UTF-8''%D0%A1%D1%85%D0%B5%D0%BC%D0%B0%20%28v2%29.png`,
      )
      expect(params.get('X-Amz-Expires')).toBe(String(DOWNLOAD_URL_TTL_SECONDS))
      expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(before + DOWNLOAD_URL_TTL_SECONDS * 1000)
    })

    it('names and types the download after the result type', async () => {
      const { jobId } = await finishedJob({
        originalName: 'sticker.WEBP',
        inputType: 'image/webp',
        outputType: 'image/webp',
      })

      const { url } = downloadJobResponseSchema.parse((await download(jobId).expect(200)).body)

      const params = new URL(url).searchParams
      expect(params.get('response-content-type')).toBe('image/webp')
      expect(params.get('response-content-disposition')).toBe(
        `attachment; filename="sticker.webp"; filename*=UTF-8''sticker.webp`,
      )
    })

    it('falls back to the input type for jobs stored without a result type', async () => {
      const { jobId } = await finishedJob({ originalName: 'photo.jpeg', inputType: 'image/jpeg' })
      await firestore.doc(`jobs/${jobId}`).update({ outputType: FieldValue.delete() })

      const { url } = downloadJobResponseSchema.parse((await download(jobId).expect(200)).body)

      const params = new URL(url).searchParams
      expect(params.get('response-content-type')).toBe('image/jpeg')
      expect(params.get('response-content-disposition')).toBe(
        `attachment; filename="photo.jpg"; filename*=UTF-8''photo.jpg`,
      )
    })

    it('returns a URL the browser can display when asked for inline', async () => {
      const { jobId } = await finishedJob({ originalName: 'logo.png' })

      const { url } = downloadJobResponseSchema.parse(
        (await http().get(`/jobs/${jobId}/download?disposition=inline`).set(auth()).expect(200)).body,
      )

      expect(new URL(url).searchParams.get('response-content-disposition')).toBe(
        `inline; filename="logo.png"; filename*=UTF-8''logo.png`,
      )
      await http().get(`/jobs/${jobId}/download?disposition=render`).set(auth()).expect(400)
    })

    it('refuses jobs that are not finished', async () => {
      for (const status of ['awaiting_upload', 'queued', 'processing', 'failed']) {
        const { jobId } = await finishedJob({ status, outputKey: null })
        await download(jobId).expect(409)
      }
    })

    it("hides other users' jobs and unknown ids", async () => {
      const { jobId } = await finishedJob()
      const other = await signInAnonymously()

      await download(jobId, other.token).expect(404)
      await download('a1B2c3D4e5F6g7H8i9J0').expect(404)
      await download('not-a-job-id').expect(404)
      await http().get(`/jobs/${jobId}/download`).expect(401)
    })

    it('tells a tab that still shows a removed job that the image is gone', async () => {
      const { jobId } = await finishedJob()
      await firestore.doc(`jobs/${jobId}`).delete()

      const response = await download(jobId).expect(404)

      expect(response.body).toMatchObject({ message: 'The image is no longer available' })
    })
  })

  describe('DELETE /jobs/:id', () => {
    const remove = (jobId: string, token = user.token) => http().delete(`/jobs/${jobId}`).set(auth(token))

    it('deletes the job, its original, its result and its preview', async () => {
      const { jobId } = await finishedJob()

      await remove(jobId).expect(204)

      expect(await job(jobId)).toBeUndefined()
      expect(storage.objects.size).toBe(0)
      expect(cdn.assets.size).toBe(0)
      await remove(jobId).expect(404)
    })

    it('deletes a job that was never uploaded', async () => {
      const { jobId } = await createJob()

      await remove(jobId).expect(204)

      expect(await job(jobId)).toBeUndefined()
    })

    it('does not give back quota already used by the job', async () => {
      const { jobId } = await createJob()
      storage.upload(`originals/${user.uid}/${jobId}`)
      await submit(jobId).expect(200)

      await remove(jobId).expect(204)

      expect(await jobsToday()).toBe(1)
    })

    it('deletes the job even when its files cannot be removed', async () => {
      const { jobId } = await finishedJob()
      storage.unavailable.add('delete')
      cdn.unavailable.add('delete')

      await remove(jobId).expect(204)

      expect(await job(jobId)).toBeUndefined()
    })

    it("cannot delete other users' jobs", async () => {
      const { jobId, keys } = await finishedJob()
      const other = await signInAnonymously()

      await remove(jobId, other.token).expect(404)
      await remove('not-a-job-id').expect(404)
      await http().delete(`/jobs/${jobId}`).expect(401)

      expect(await job(jobId)).toMatchObject({ status: 'done' })
      expect([...storage.objects.keys()].sort()).toEqual(keys.sort())
      expect(cdn.assets.has(jobId)).toBe(true)
    })
  })
})

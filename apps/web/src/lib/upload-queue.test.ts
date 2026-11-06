import type { CreateJobRequest } from '@onetodone/image-compressor-shared'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from './api-error'
import { type QueuedPatch, UploadQueue, type UploadSteps } from './upload-queue'

function request(name: string): CreateJobRequest {
  return { originalName: name, contentType: 'image/jpeg', size: 10, settings: { preset: 'balanced' } }
}

/** Steps that succeed, with a server-side quota of `limit` submits; uploads resolve when released. */
function fakeSteps({ limit = Infinity, holdUploads = false } = {}) {
  let submitted = 0
  let running = 0
  let maxRunning = 0
  let maxSubmitting = 0
  let submitting = 0
  const releases: (() => void)[] = []
  const steps: UploadSteps = {
    create: vi.fn(async (body: CreateJobRequest) => {
      if (submitted >= limit) throw new ApiError(429, 'limit', 'daily_limit')
      return { jobId: `job-${body.originalName}`, uploadUrl: `https://r2.test/${body.originalName}` }
    }),
    upload: vi.fn(async (_url, _file, _type, onProgress) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      if (holdUploads) await new Promise<void>((resolve) => releases.push(resolve))
      onProgress(0.5)
      running--
    }),
    submit: vi.fn(async () => {
      submitting++
      maxSubmitting = Math.max(maxSubmitting, submitting)
      await Promise.resolve()
      submitting--
      if (submitted >= limit) throw new ApiError(429, 'limit', 'daily_limit')
      submitted++
    }),
    discard: vi.fn(async () => undefined),
  }
  return {
    steps,
    releaseAll: () => releases.splice(0).forEach((release) => release()),
    stats: () => ({ submitted, maxRunning, maxSubmitting }),
  }
}

function track() {
  const states = new Map<string, QueuedPatch>()
  const onChange = (key: string, patch: QueuedPatch) => states.set(key, { ...states.get(key), ...patch })
  return { states, onChange }
}

async function settle(queue: UploadQueue) {
  await vi.waitFor(() => expect(queue.pending).toBe(0))
}

const file = new Blob(['x'])

describe('UploadQueue', () => {
  it('creates, uploads and submits every file', async () => {
    const { steps, stats } = fakeSteps()
    const { states, onChange } = track()
    const queue = new UploadQueue(steps, onChange)
    for (const name of ['a', 'b']) queue.add(name, file, request(name))
    await settle(queue)

    expect(states.get('a')).toMatchObject({ stage: 'submitted', jobId: 'job-a', progress: 1 })
    expect(states.get('b')).toMatchObject({ stage: 'submitted', jobId: 'job-b' })
    expect(stats().submitted).toBe(2)
  })

  it('uploads only a few files at once and submits them one after another', async () => {
    const { steps, releaseAll, stats } = fakeSteps({ holdUploads: true })
    const { states, onChange } = track()
    const queue = new UploadQueue(steps, onChange, 3)
    const names = Array.from({ length: 10 }, (_, index) => `f${index}`)
    for (const name of names) queue.add(name, file, request(name))

    await vi.waitFor(() => expect(steps.upload).toHaveBeenCalledTimes(3))
    expect(states.get('f9')).toBeUndefined()
    expect(queue.pending).toBe(10)

    const release = setInterval(releaseAll, 1)
    await settle(queue)
    clearInterval(release)

    expect(stats()).toMatchObject({ submitted: 10, maxRunning: 3, maxSubmitting: 1 })
    expect(names.every((name) => states.get(name)?.stage === 'submitted')).toBe(true)
  })

  it('marks files beyond the quota as limited and does not upload the ones still waiting', async () => {
    const { steps, releaseAll, stats } = fakeSteps({ limit: 5, holdUploads: true })
    const { states, onChange } = track()
    const queue = new UploadQueue(steps, onChange, 3)
    const names = Array.from({ length: 10 }, (_, index) => `f${index}`)
    for (const name of names) queue.add(name, file, request(name))

    const release = setInterval(releaseAll, 1)
    await settle(queue)
    clearInterval(release)

    const stages = names.map((name) => states.get(name)?.stage)
    expect(stats().submitted).toBe(5)
    expect(stages.filter((stage) => stage === 'submitted')).toHaveLength(5)
    expect(stages.filter((stage) => stage === 'limited')).toHaveLength(5)
    expect(
      names.every((name) => states.get(name)?.stage !== 'limited' || states.get(name)?.limit === 'daily_limit'),
    ).toBe(true)
    // Files in flight when the limit is hit are refused at submit; the rest never start.
    expect(vi.mocked(steps.upload).mock.calls.length).toBeLessThan(10)
    // A job refused at submit is deleted, so it does not stay in the list as not uploaded.
    for (const [jobId] of vi.mocked(steps.discard).mock.calls) {
      expect(states.get(jobId.replace('job-', ''))).toMatchObject({ stage: 'limited', jobId: null })
    }
  })

  it('keeps the limit that refused the file', async () => {
    const { steps } = fakeSteps()
    vi.mocked(steps.submit).mockRejectedValueOnce(new ApiError(429, 'network', 'network_daily_limit'))
    const { states, onChange } = track()
    const queue = new UploadQueue(steps, onChange)
    queue.add('a', file, request('a'))
    await settle(queue)

    expect(states.get('a')).toMatchObject({ stage: 'limited', limit: 'network_daily_limit' })
    expect(steps.discard).toHaveBeenCalledWith('job-a')
  })

  it('shows a safe message for other failures and goes on with the next file', async () => {
    const { steps } = fakeSteps()
    vi.mocked(steps.create).mockRejectedValueOnce(new ApiError(400, 'The file must be at most 10 MB'))
    vi.mocked(steps.upload).mockRejectedValueOnce(new Error('socket hang up'))
    const { states, onChange } = track()
    const queue = new UploadQueue(steps, onChange, 1)
    for (const name of ['a', 'b', 'c']) queue.add(name, file, request(name))
    await settle(queue)

    expect(states.get('a')).toMatchObject({ stage: 'error', error: 'The file must be at most 10 MB' })
    expect(states.get('b')).toMatchObject({ stage: 'error', error: 'Something went wrong. Try again.' })
    expect(states.get('c')).toMatchObject({ stage: 'submitted' })
    expect(steps.discard).not.toHaveBeenCalled()
  })
})
